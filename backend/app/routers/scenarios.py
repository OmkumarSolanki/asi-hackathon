from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.core.loaders import (
    LAT_MAX, LAT_MIN, LON_MAX, LON_MIN, WX_COLS, WX_ROWS,
    find_wx_frame_at, list_scenarios, list_weather_files, load_routes, load_sectors,
)
from app.core.simulator import (
    flight_position_at, sector_loads_at,
)
from app.services.advisor import advise

router = APIRouter()


def _parse_t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


@router.get("/scenarios")
def scenarios_list() -> dict[str, Any]:
    sids = list_scenarios()
    out = []
    for sid in sids:
        try:
            r = load_routes(sid)
            wx = list_weather_files(sid, "refc")
            out.append({
                "id": sid,
                "asked_at": r["asked_at"],
                "n_flights": len(r["flights"]),
                "window_start": r["window_start"],
                "window_end": r["window_end"],
                "wx_frames": len(wx),
            })
        except Exception:
            out.append({"id": sid, "error": True})
    return {"scenarios": out}


@router.get("/scenarios/{sid}/flights")
def flights_list(sid: str, airborne_only: bool = True, limit: int = 5000) -> dict[str, Any]:
    r = load_routes(sid)
    items = []
    for f in r["flights"]:
        if airborne_only and not f["is_airborne"]:
            continue
        items.append({
            "id": f["flight_id"],
            "callsign": f["flight_number"],
            "origin": f["origin_airport_icao"],
            "destination": f["destination_airport_icao"],
            "altitude_ft": float(f["cruise_altitude_ft"]),
            "cruise_kt": float(f["cruise_speed_kt"]),
            "take_off_time": f["take_off_time"],
            "scheduled_landing_time": f["scheduled_landing_time"],
            "lats": f["lats"].tolist(),
            "lons": f["lons"].tolist(),
            "is_airborne": f["is_airborne"],
        })
        if len(items) >= limit:
            break
    return {
        "scenario": sid,
        "asked_at": r["asked_at"],
        "count": len(items),
        "flights": items,
    }


@router.get("/scenarios/{sid}/weather")
def weather_at(sid: str, t: str, kind: str = "refc") -> dict[str, Any]:
    """Return the weather grid at time t as a flat array of values."""
    when = _parse_t(t)
    frame = find_wx_frame_at(sid, kind, when)
    if frame is None:
        raise HTTPException(404, "no wx frame found")
    arr = np.asarray(frame, dtype=np.float32)
    # mask nodata to NaN for the client
    if kind == "refc":
        arr = np.where(arr <= -50, np.nan, arr)
    else:
        arr = np.where(arr < 0, np.nan, arr)
    return {
        "scenario": sid,
        "kind": kind,
        "time": t,
        "rows": WX_ROWS,
        "cols": WX_COLS,
        "bbox": {"lat_min": LAT_MIN, "lat_max": LAT_MAX, "lon_min": LON_MIN, "lon_max": LON_MAX},
        # nan-safe: convert to lists with None for NaN
        "values": [None if (v != v) else float(v) for v in arr.flatten().tolist()],
    }


@router.get("/scenarios/{sid}/sectors")
def sectors_at(sid: str, t: str, band: str | None = None) -> dict[str, Any]:
    when = _parse_t(t)
    loads = sector_loads_at(sid, when)
    sec = load_sectors()
    feats = []
    for f in sec["features"]:
        p = f["properties"]
        if band == "high" and not p["name"].startswith("HIGH_"):
            continue
        if band == "low" and not p["name"].startswith("LOW_"):
            continue
        load = loads.get(p["name"], 0)
        load_pct = load / max(p["capacity"], 1)
        feats.append({
            "type": "Feature",
            "geometry": f["geometry"],
            "properties": {**p, "load": load, "load_pct": round(load_pct, 3)},
        })
    return {
        "type": "FeatureCollection",
        "time": t,
        "features": feats,
    }


class AdviseBody(BaseModel):
    scenario: str
    flight: str
    time: str


@router.post("/advise")
def advise_endpoint(body: AdviseBody) -> dict[str, Any]:
    return advise(body.scenario, body.flight, body.time)


@router.get("/scenarios/{sid}/hero-flights")
def hero_flights(sid: str, limit: int = 12) -> dict[str, Any]:
    """Return flights with dramatic weather encounters — good demo subjects."""
    from app.core.simulator import flight_weather_encounters
    r = load_routes(sid)
    out = []
    for f in r["flights"]:
        if not f["is_airborne"]:
            continue
        enc = flight_weather_encounters(sid, f, step_min=10)
        if not enc:
            continue
        max_refc = max(e["refc_dbz"] for e in enc)
        out.append({
            "id": f["flight_id"],
            "callsign": f["flight_number"],
            "origin": f["origin_airport_icao"],
            "destination": f["destination_airport_icao"],
            "altitude_ft": float(f["cruise_altitude_ft"]),
            "encounters": len(enc),
            "max_refc": round(float(max_refc), 1),
            "drama_score": len(enc) * 5 + float(max_refc),
        })
        if len(out) >= 200:
            break
    out.sort(key=lambda r: r["drama_score"], reverse=True)
    return {"scenario": sid, "flights": out[:limit]}


@router.get("/scenarios/{sid}/winds")
def winds_at(sid: str, t: str) -> dict[str, Any]:
    from app.services.winds import fetch_winds
    return fetch_winds(t)


@router.get("/scenarios/{sid}/timesteps")
def timesteps_for(sid: str, kind: str = "refc") -> dict[str, Any]:
    entries = list_weather_files(sid, kind)
    return {
        "scenario": sid,
        "kind": kind,
        "timesteps": [e["valid_from"].isoformat() for e in entries],
    }
