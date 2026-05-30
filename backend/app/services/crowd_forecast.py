from __future__ import annotations

"""Crowd-Forecast Confidence engine.

The signal: do nearby flights' FILED routes detour around a weather cell, or fly through it?
If filed routes detour, the airlines have already 'voted' that the weather is dangerous.

We measure deviation by comparing each flight's filed waypoints against its great-circle
direct path. The detour ratio (filed_distance / great_circle_distance) is the strength
of the planners' avoidance.
"""

from datetime import datetime, timedelta
from typing import Any

import numpy as np

from app.core.geo import haversine_nm, great_circle_points, cumulative_distances_nm
from app.core.loaders import load_routes
from app.core.simulator import flight_position_at, REFC_HAZARD_DBZ, sample_wx_at


def filed_vs_gc_ratio(flight: dict[str, Any]) -> float:
    lats = flight["lats"]
    lons = flight["lons"]
    if len(lats) < 2:
        return 1.0
    filed_dist = float(cumulative_distances_nm(lats, lons)[-1])
    gc_dist = haversine_nm(float(lats[0]), float(lons[0]), float(lats[-1]), float(lons[-1]))
    if gc_dist <= 0:
        return 1.0
    return filed_dist / gc_dist


def _max_offset_from_gc_nm(flight: dict[str, Any]) -> float:
    """Max perpendicular-ish offset of filed waypoints from the great-circle path."""
    lats = flight["lats"]
    lons = flight["lons"]
    if len(lats) < 3:
        return 0.0
    gc_lats, gc_lons = great_circle_points(float(lats[0]), float(lons[0]), float(lats[-1]), float(lons[-1]), n=80)
    # For each filed waypoint, find min distance to any GC point
    max_off = 0.0
    for la, lo in zip(lats[1:-1], lons[1:-1]):
        d = np.min([haversine_nm(float(la), float(lo), float(gla), float(glo)) for gla, glo in zip(gc_lats, gc_lons)])
        if d > max_off:
            max_off = float(d)
    return max_off


def nearby_flights(scenario_id: str, lat: float, lon: float, t: datetime, radius_nm: float = 120.0) -> list[dict[str, Any]]:
    """Flights whose planned route passes within `radius_nm` of (lat, lon) within ±2 hours of t."""
    routes = load_routes(scenario_id)
    out: list[dict[str, Any]] = []
    t_lo = t - timedelta(hours=2)
    t_hi = t + timedelta(hours=2)
    for fl in routes["flights"]:
        # quick reject by time overlap
        if fl["scheduled_landing_time_dt"] < t_lo or fl["take_off_time_dt"] > t_hi:
            continue
        # check minimum distance from any waypoint to (lat, lon)
        lats = fl["lats"]; lons = fl["lons"]
        d_min = float("inf")
        for la, lo in zip(lats, lons):
            d = haversine_nm(lat, lon, float(la), float(lo))
            if d < d_min:
                d_min = d
            if d_min <= radius_nm:
                break
        if d_min <= radius_nm:
            out.append(fl)
    return out


def crowd_signal(scenario_id: str, around_lat: float, around_lon: float, t: datetime, alt_ft: float) -> dict[str, Any]:
    """For the conflict area, aggregate nearby flights' filed-vs-GC behavior."""
    nearby = nearby_flights(scenario_id, around_lat, around_lon, t, radius_nm=120.0)
    if not nearby:
        return {
            "n_observed": 0,
            "n_detoured": 0,
            "median_detour_pct": 0.0,
            "max_offset_nm": 0.0,
            "verdict": "UNKNOWN",
            "headline": "No nearby flights to learn from.",
            "examples": [],
        }
    rows: list[dict[str, Any]] = []
    detoured = 0
    detour_pcts: list[float] = []
    offsets: list[float] = []
    for fl in nearby:
        ratio = filed_vs_gc_ratio(fl)
        detour_pct = (ratio - 1.0) * 100.0
        offset = _max_offset_from_gc_nm(fl)
        is_detour = detour_pct >= 2.0 or offset >= 30.0
        if is_detour:
            detoured += 1
        detour_pcts.append(detour_pct)
        offsets.append(offset)
        gc_lats, gc_lons = great_circle_points(
            float(fl["lats"][0]), float(fl["lons"][0]),
            float(fl["lats"][-1]), float(fl["lons"][-1]),
            n=24,
        )
        rows.append({
            "flight": fl["flight_number"],
            "origin": fl["origin_airport_icao"],
            "destination": fl["destination_airport_icao"],
            "detour_pct": round(detour_pct, 1),
            "offset_nm": round(offset, 1),
            "is_detour": is_detour,
            "alt_ft": float(fl["cruise_altitude_ft"]),
            "filed_lats": [round(float(x), 4) for x in fl["lats"]],
            "filed_lons": [round(float(x), 4) for x in fl["lons"]],
            "gc_lats": [round(float(x), 4) for x in gc_lats],
            "gc_lons": [round(float(x), 4) for x in gc_lons],
        })

    n = len(rows)
    pct = detoured / n
    median_detour = float(np.median(detour_pcts))
    median_offset = float(np.median(offsets))

    if pct >= 0.6:
        verdict = "STRONG NO"
        headline = f"{detoured} of {n} nearby flights filed detours around this weather. The airlines' planning systems have already voted: this is dangerous."
    elif pct >= 0.3:
        verdict = "WEAK NO"
        headline = f"{detoured} of {n} nearby flights filed detours. Mixed signal — proceed with caution."
    elif pct >= 0.1:
        verdict = "WEAK GO"
        headline = f"Most nearby flights filed direct routes through this area. The forecast may overstate the threat."
    else:
        verdict = "STRONG GO"
        headline = f"{n} of {n} nearby flights filed direct, unaltered routes. The airlines aren't worried."

    rows.sort(key=lambda r: r["is_detour"], reverse=True)
    return {
        "n_observed": n,
        "n_detoured": detoured,
        "median_detour_pct": round(median_detour, 1),
        "median_offset_nm": round(median_offset, 1),
        "max_offset_nm": round(max(offsets) if offsets else 0.0, 1),
        "verdict": verdict,
        "headline": headline,
        "examples": rows[:8],
    }
