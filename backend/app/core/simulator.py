from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

import numpy as np
from shapely.geometry import Polygon, Point, shape
from shapely.strtree import STRtree

from app.core.geo import (
    cumulative_distances_nm,
    haversine_nm,
)
from app.core.loaders import (
    find_wx_frame_at,
    latlon_to_wx_ij,
    load_routes,
    load_sectors,
)

WX_NODATA_REFC = -50
WX_NODATA_RETOP = 0
REFC_HAZARD_DBZ = 40.0


def flight_total_distance_nm(flight: dict[str, Any]) -> float:
    return float(cumulative_distances_nm(flight["lats"], flight["lons"])[-1])


def flight_position_at(flight: dict[str, Any], t: datetime) -> tuple[float, float, str] | None:
    """Return (lat, lon, phase) at t. phase ∈ {pre_departure, cruise, landed}.
    Returns None if no useful answer. Uses constant cruise speed assumption.
    """
    if t < flight["take_off_time_dt"]:
        return float(flight["lats"][0]), float(flight["lons"][0]), "pre_departure"
    if t >= flight["scheduled_landing_time_dt"]:
        return float(flight["lats"][-1]), float(flight["lons"][-1]), "landed"
    total_secs = (flight["scheduled_landing_time_dt"] - flight["take_off_time_dt"]).total_seconds()
    if total_secs <= 0:
        return float(flight["lats"][0]), float(flight["lons"][0]), "cruise"
    fraction = (t - flight["take_off_time_dt"]).total_seconds() / total_secs
    cum = cumulative_distances_nm(flight["lats"], flight["lons"])
    total = cum[-1]
    target = fraction * total
    idx = int(np.searchsorted(cum, target, side="right")) - 1
    idx = max(0, min(len(flight["lats"]) - 2, idx))
    seg = max(cum[idx + 1] - cum[idx], 1e-9)
    seg_frac = (target - cum[idx]) / seg
    lat = float(flight["lats"][idx] + seg_frac * (flight["lats"][idx + 1] - flight["lats"][idx]))
    lon = float(flight["lons"][idx] + seg_frac * (flight["lons"][idx + 1] - flight["lons"][idx]))
    return lat, lon, "cruise"


def sample_wx_at(scenario_id: str, kind: str, lat: float, lon: float, t: datetime) -> float | None:
    frame = find_wx_frame_at(scenario_id, kind, t)
    if frame is None:
        return None
    ij = latlon_to_wx_ij(lat, lon)
    if ij is None:
        return None
    v = float(frame[ij[0], ij[1]])
    if kind == "refc" and v <= WX_NODATA_REFC:
        return None
    if kind == "retop" and v < WX_NODATA_RETOP:
        return None
    return v


def weather_conflict(scenario_id: str, lat: float, lon: float, alt_ft: float, t: datetime) -> dict[str, Any] | None:
    """Returns dict if weather threatens (lat,lon,alt) at t. None otherwise."""
    refc = sample_wx_at(scenario_id, "refc", lat, lon, t)
    if refc is None or refc < REFC_HAZARD_DBZ:
        return None
    retop = sample_wx_at(scenario_id, "retop", lat, lon, t)
    if retop is None:
        return {"refc_dbz": refc, "retop_ft": None, "severity": _severity(refc, None)}
    if retop <= alt_ft:
        return None
    return {"refc_dbz": refc, "retop_ft": retop, "severity": _severity(refc, retop)}


def _severity(refc: float, retop: float | None) -> str:
    if refc >= 55:
        return "severe"
    if refc >= 45:
        return "heavy"
    return "moderate"


@lru_cache(maxsize=4)
def _sectors_indexed() -> tuple[STRtree, list[dict[str, Any]], list[Polygon]]:
    sec = load_sectors()
    feats = sec["features"]
    polys: list[Polygon] = []
    props: list[dict[str, Any]] = []
    for f in feats:
        polys.append(shape(f["geometry"]))
        props.append(f["properties"])
    tree = STRtree(polys)
    return tree, props, polys


def sector_for(lat: float, lon: float, alt_ft: float) -> dict[str, Any] | None:
    tree, props, polys = _sectors_indexed()
    pt = Point(lon, lat)
    hits = tree.query(pt)
    for idx in hits:
        p = props[idx]
        if not (p["altitude_from_ft"] <= alt_ft < p["altitude_to_ft"]):
            continue
        if polys[idx].contains(pt):
            return {**p, "_idx": int(idx)}
    return None


def all_sectors_summary(band: str | None = None) -> list[dict[str, Any]]:
    sec = load_sectors()
    out = []
    for f in sec["features"]:
        p = f["properties"]
        if band == "high" and not p["name"].startswith("HIGH_"):
            continue
        if band == "low" and not p["name"].startswith("LOW_"):
            continue
        out.append(p)
    return out


def flight_path_at_times(flight: dict[str, Any], times: list[datetime]) -> list[tuple[float, float, str]]:
    return [flight_position_at(flight, t) for t in times]


def time_window_for_scenario(scenario_id: str, steps: int = 24, step_min: int = 15) -> list[datetime]:
    routes = load_routes(scenario_id)
    start: datetime = routes["asked_at_dt"]
    return [start + timedelta(minutes=i * step_min) for i in range(steps)]


def sector_loads_at(scenario_id: str, t: datetime) -> dict[str, int]:
    """Count flights present in each sector at time t. Keys are sector names."""
    routes = load_routes(scenario_id)
    loads: dict[str, int] = {}
    for f in routes["flights"]:
        pos = flight_position_at(f, t)
        if pos is None:
            continue
        lat, lon, phase = pos
        if phase != "cruise":
            continue
        sec = sector_for(lat, lon, float(f["cruise_altitude_ft"]))
        if sec is None:
            continue
        loads[sec["name"]] = loads.get(sec["name"], 0) + 1
    return loads


def flight_weather_encounters(scenario_id: str, flight: dict[str, Any], step_min: int = 5) -> list[dict[str, Any]]:
    """Walk the flight's planned path, return weather-conflict points along the way."""
    encounters: list[dict[str, Any]] = []
    t0 = flight["take_off_time_dt"]
    t1 = flight["scheduled_landing_time_dt"]
    steps = max(2, int((t1 - t0).total_seconds() / 60 / step_min))
    for i in range(steps + 1):
        frac = i / steps
        t = t0 + (t1 - t0) * frac
        pos = flight_position_at(flight, t)
        if pos is None:
            continue
        lat, lon, _ = pos
        conf = weather_conflict(scenario_id, lat, lon, float(flight["cruise_altitude_ft"]), t)
        if conf is not None:
            encounters.append({
                "time": t.isoformat(),
                "lat": lat,
                "lon": lon,
                "alt_ft": float(flight["cruise_altitude_ft"]),
                **conf,
            })
    return encounters
