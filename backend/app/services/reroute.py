from __future__ import annotations

"""A* reroute generator on a coarse lat/lon grid, weather + sector aware."""

import heapq
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import numpy as np

from app.core.geo import haversine_nm, great_circle_points
from app.core.simulator import (
    REFC_HAZARD_DBZ,
    sample_wx_at,
    sector_for,
    sector_loads_at,
)


GRID_LAT_STEP = 0.5  # ~30 nm at mid-lats
GRID_LON_STEP = 0.7  # ~30 nm
NEIGHBOR_OFFSETS = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1),           (0, 1),
    (1, -1),  (1, 0),  (1, 1),
    (-2, 0), (2, 0), (0, -2), (0, 2),  # mild long jumps for smoother paths
]


@dataclass(order=True)
class _Node:
    f: float
    g: float = field(compare=False)
    lat: float = field(compare=False)
    lon: float = field(compare=False)
    parent: Any = field(default=None, compare=False)


def _heuristic_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return haversine_nm(lat1, lon1, lat2, lon2)


def _is_blocked(
    scenario_id: str, lat: float, lon: float, alt_ft: float, t: datetime,
    block_full_sectors: bool, sector_load_snapshot: dict[str, int],
) -> tuple[bool, str | None]:
    refc = sample_wx_at(scenario_id, "refc", lat, lon, t)
    if refc is not None and refc >= REFC_HAZARD_DBZ:
        retop = sample_wx_at(scenario_id, "retop", lat, lon, t)
        if retop is None or retop > alt_ft:
            return True, "weather"
    if block_full_sectors:
        sec = sector_for(lat, lon, alt_ft)
        if sec is not None:
            load = sector_load_snapshot.get(sec["name"], 0)
            if load >= sec["capacity"]:
                return True, f"sector {sec['name']} full ({load}/{sec['capacity']})"
    return False, None


def astar_route(
    scenario_id: str,
    start_lat: float,
    start_lon: float,
    goal_lat: float,
    goal_lon: float,
    alt_ft: float,
    t_start: datetime,
    cruise_kt: float,
    avoid_lat_bias: float = 0.0,
    avoid_lon_bias: float = 0.0,
    block_full_sectors: bool = True,
    max_iterations: int = 4000,
) -> dict[str, Any]:
    """A* on a snap-to-grid lat/lon graph. Returns dict with status and route."""
    sector_load = sector_loads_at(scenario_id, t_start)

    def snap(lat, lon):
        i = round(lat / GRID_LAT_STEP)
        j = round(lon / GRID_LON_STEP)
        return (i, j)

    start_key = snap(start_lat, start_lon)
    goal_key = snap(goal_lat, goal_lon)

    open_heap: list[_Node] = []
    heapq.heappush(open_heap, _Node(
        f=_heuristic_nm(start_lat, start_lon, goal_lat, goal_lon),
        g=0.0, lat=start_lat, lon=start_lon, parent=None,
    ))
    came_from: dict[tuple[int, int], _Node] = {}
    g_score: dict[tuple[int, int], float] = {start_key: 0.0}
    rejection_reason: str | None = None
    iters = 0

    while open_heap and iters < max_iterations:
        iters += 1
        cur = heapq.heappop(open_heap)
        cur_key = snap(cur.lat, cur.lon)
        if cur_key == goal_key or haversine_nm(cur.lat, cur.lon, goal_lat, goal_lon) < 40:
            # reconstruct
            path: list[tuple[float, float]] = [(goal_lat, goal_lon)]
            node = cur
            while node is not None:
                path.append((node.lat, node.lon))
                node = node.parent
            path.reverse()
            # simplify by removing colinear duplicates
            simplified = [path[0]]
            for p in path[1:]:
                if haversine_nm(simplified[-1][0], simplified[-1][1], p[0], p[1]) > 5:
                    simplified.append(p)
            return {
                "status": "ok",
                "lats": [p[0] for p in simplified],
                "lons": [p[1] for p in simplified],
                "iterations": iters,
                "distance_nm": cur.g,
            }
        for di, dj in NEIGHBOR_OFFSETS:
            nlat = cur.lat + di * GRID_LAT_STEP + avoid_lat_bias * 0.02
            nlon = cur.lon + dj * GRID_LON_STEP + avoid_lon_bias * 0.02
            nkey = snap(nlat, nlon)
            seg = haversine_nm(cur.lat, cur.lon, nlat, nlon)
            t_at = t_start + timedelta(hours=(cur.g + seg) / cruise_kt)
            blocked, reason = _is_blocked(
                scenario_id, nlat, nlon, alt_ft, t_at, block_full_sectors, sector_load,
            )
            if blocked:
                rejection_reason = reason
                continue
            tentative_g = cur.g + seg
            if tentative_g < g_score.get(nkey, float("inf")):
                g_score[nkey] = tentative_g
                h = _heuristic_nm(nlat, nlon, goal_lat, goal_lon)
                heapq.heappush(open_heap, _Node(
                    f=tentative_g + h, g=tentative_g, lat=nlat, lon=nlon, parent=cur,
                ))
    return {"status": "no_path", "reason": rejection_reason or "exhausted search"}


def generate_candidates(
    scenario_id: str,
    current_lat: float, current_lon: float,
    dest_lat: float, dest_lon: float,
    alt_ft: float, cruise_kt: float, t_start: datetime,
) -> list[dict[str, Any]]:
    """Generate a fan of candidate routes with different avoidance biases."""
    candidates: list[dict[str, Any]] = []

    # 1) Direct (great circle) — may or may not be viable
    gc_lats, gc_lons = great_circle_points(current_lat, current_lon, dest_lat, dest_lon, n=20)
    candidates.append({
        "id": "direct",
        "label": "Direct (filed)",
        "lats": gc_lats.tolist(),
        "lons": gc_lons.tolist(),
        "strategy": "direct",
    })

    # 2-5) A* with different biases (left/right, mild/strong)
    biases = [
        ("right_mild",  "Deviate 20° Right", 0.0, 1.0),
        ("left_mild",   "Deviate 20° Left",  0.0, -1.0),
        ("right_strong","Hard Right Detour", 1.0, 1.5),
        ("left_strong", "Hard Left Detour",  1.0, -1.5),
        ("north_arc",   "North Arc",         2.0, 0.0),
        ("south_arc",   "South Arc",        -2.0, 0.0),
    ]
    for rid, label, lat_b, lon_b in biases:
        r = astar_route(
            scenario_id, current_lat, current_lon, dest_lat, dest_lon,
            alt_ft, t_start, cruise_kt,
            avoid_lat_bias=lat_b, avoid_lon_bias=lon_b,
        )
        if r["status"] == "ok":
            candidates.append({
                "id": rid, "label": label,
                "lats": r["lats"], "lons": r["lons"], "strategy": rid,
            })
        else:
            candidates.append({
                "id": rid, "label": label, "status": "rejected",
                "reason": r.get("reason"), "strategy": rid,
            })

    return candidates


def evaluate_route(
    scenario_id: str,
    lats: list[float], lons: list[float],
    alt_ft: float, cruise_kt: float, t_start: datetime,
    aircraft_type: str,
) -> dict[str, Any]:
    from app.core.geo import cumulative_distances_nm
    from app.services.fuel import fuel_burn_lb
    lats_a = np.asarray(lats); lons_a = np.asarray(lons)
    cum = cumulative_distances_nm(lats_a, lons_a)
    total_nm = float(cum[-1])
    flight_time_hr = total_nm / cruise_kt
    # weather encounters along the path
    encounters = 0
    max_refc = -100.0
    n = max(2, int(total_nm / 25))  # sample every ~25 nm
    sector_load = sector_loads_at(scenario_id, t_start)
    sector_violations: list[str] = []
    for i in range(n + 1):
        frac = i / n
        target = frac * total_nm
        idx = int(np.searchsorted(cum, target, side="right")) - 1
        idx = max(0, min(len(lats_a) - 2, idx))
        seg = max(cum[idx + 1] - cum[idx], 1e-9)
        sf = (target - cum[idx]) / seg
        lat = float(lats_a[idx] + sf * (lats_a[idx + 1] - lats_a[idx]))
        lon = float(lons_a[idx] + sf * (lons_a[idx + 1] - lons_a[idx]))
        t = t_start + timedelta(hours=(target / cruise_kt))
        refc = sample_wx_at(scenario_id, "refc", lat, lon, t)
        if refc is not None and refc >= REFC_HAZARD_DBZ:
            encounters += 1
            if refc > max_refc:
                max_refc = refc
        sec = sector_for(lat, lon, alt_ft)
        if sec is not None:
            load = sector_load.get(sec["name"], 0)
            if load >= sec["capacity"]:
                sector_violations.append(sec["name"])
    fuel_lb = fuel_burn_lb(total_nm, aircraft_type, alt_ft)
    # compute sector transit list + worst load
    sectors_transited: list[str] = []
    sectors_seen: set[str] = set()
    max_sector_load_pct = 0.0
    for i in range(n + 1):
        frac = i / n
        target = frac * total_nm
        idx = int(np.searchsorted(cum, target, side="right")) - 1
        idx = max(0, min(len(lats_a) - 2, idx))
        seg = max(cum[idx + 1] - cum[idx], 1e-9)
        sf = (target - cum[idx]) / seg
        lat = float(lats_a[idx] + sf * (lats_a[idx + 1] - lats_a[idx]))
        lon = float(lons_a[idx] + sf * (lons_a[idx + 1] - lons_a[idx]))
        sec = sector_for(lat, lon, alt_ft)
        if sec is None:
            continue
        if sec["name"] not in sectors_seen:
            sectors_seen.add(sec["name"])
            sectors_transited.append(sec["name"])
        load = sector_load.get(sec["name"], 0)
        load_pct = load / max(sec["capacity"], 1)
        if load_pct > max_sector_load_pct:
            max_sector_load_pct = load_pct
    return {
        "distance_nm": round(total_nm, 1),
        "time_min": round(flight_time_hr * 60, 1),
        "fuel_lb": round(fuel_lb, 0),
        "weather_encounters": encounters,
        "max_refc_dbz": max_refc if max_refc > -100 else None,
        "sector_violations": list(dict.fromkeys(sector_violations)),
        "sectors_transited": sectors_transited,
        "max_sector_load_pct": round(max_sector_load_pct, 3),
    }
