from __future__ import annotations

"""Top-level advisory orchestrator: takes (scenario, flight_id, time) → full advisory payload."""

from datetime import datetime, timezone
from typing import Any

import numpy as np

from app.core.geo import cumulative_distances_nm, haversine_nm
from app.core.loaders import load_routes
from app.core.simulator import (
    flight_position_at,
    flight_weather_encounters,
    sample_wx_at,
    sector_for,
    sector_loads_at,
    REFC_HAZARD_DBZ,
)
from app.services.briefing import generate_briefing
from app.services.crowd_forecast import crowd_signal
from app.services.fuel import aircraft_type_for, fuel_burn_lb, planned_fuel_load_lb
from app.services.metar import landing_assessment
from app.services.pirep import analog_summary, find_analogs
from app.services.reroute import evaluate_route, generate_candidates


def _parse_t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def _find_flight(scenario_id: str, flight_id: str) -> dict[str, Any] | None:
    routes = load_routes(scenario_id)
    for fl in routes["flights"]:
        if fl["flight_id"] == flight_id or fl["flight_number"] == flight_id:
            return fl
    return None


def advise(scenario_id: str, flight_id: str, t_iso: str) -> dict[str, Any]:
    t = _parse_t(t_iso)
    fl = _find_flight(scenario_id, flight_id)
    if fl is None:
        return {"error": f"flight {flight_id} not found in scenario {scenario_id}"}

    callsign = fl["flight_number"]
    alt_ft = float(fl["cruise_altitude_ft"])
    cruise_kt = float(fl["cruise_speed_kt"])
    pos = flight_position_at(fl, t)
    if pos is None:
        return {"error": "could not compute flight position at time"}
    cur_lat, cur_lon, phase = pos
    dest_lat = float(fl["lats"][-1])
    dest_lon = float(fl["lons"][-1])

    # weather encounters along the remaining filed path
    encounters = flight_weather_encounters(scenario_id, fl, step_min=10)
    # Filter encounters that are still ahead in time
    future_enc = [e for e in encounters if _parse_t(e["time"]) >= t]
    weather_summary = "no significant convection on filed route"
    refc_for_query = 0.0
    retop_for_query: float | None = None
    if future_enc:
        e0 = future_enc[0]
        weather_summary = (
            f"convection at {e0.get('refc_dbz', 0):.0f} dBZ, "
            f"FL{int(alt_ft/100)} margin {int((e0.get('retop_ft') or alt_ft) - alt_ft)} ft"
        )
        refc_for_query = float(e0["refc_dbz"])
        retop_for_query = e0.get("retop_ft")

    # current sector / load
    cur_sector = sector_for(cur_lat, cur_lon, alt_ft)
    sec_loads = sector_loads_at(scenario_id, t)

    # candidate routes
    candidates = generate_candidates(
        scenario_id, cur_lat, cur_lon, dest_lat, dest_lon, alt_ft, cruise_kt, t,
    )

    # great circle baseline for the remaining leg, used as "your current filed plan"
    filed_remaining_dist = haversine_nm(cur_lat, cur_lon, dest_lat, dest_lon)
    aircraft_type = aircraft_type_for(callsign)

    # evaluate every candidate
    viable: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for c in candidates:
        if c.get("status") == "rejected":
            rejected.append({"id": c["id"], "label": c["label"], "reason": c.get("reason")})
            continue
        ev = evaluate_route(scenario_id, c["lats"], c["lons"], alt_ft, cruise_kt, t, aircraft_type)
        ev_blob = {**c, **ev}
        # auto-reject if route still hits weather
        if ev["weather_encounters"] > 0 and c["id"] != "direct":
            rejected.append({
                "id": c["id"], "label": c["label"],
                "lats": c["lats"], "lons": c["lons"],
                "reason": f"still crosses weather ({ev['weather_encounters']} hits)",
                **{k: v for k, v in ev.items() if k not in ("lats", "lons")},
            })
        elif ev["sector_violations"] and c["id"] != "direct":
            rejected.append({
                "id": c["id"], "label": c["label"],
                "lats": c["lats"], "lons": c["lons"],
                "reason": f"sector violation: {', '.join(ev['sector_violations'][:2])}",
                **{k: v for k, v in ev.items() if k not in ("lats", "lons")},
            })
        else:
            viable.append(ev_blob)

    # Rank viable by composite: fewer encounters > min distance > min sector load.
    def score(opt: dict[str, Any]) -> float:
        enc = opt.get("weather_encounters", 0)
        d = opt.get("distance_nm", 0)
        return enc * 1000 + d
    viable.sort(key=score)

    # If "direct" is among viable, but has encounters, push it below detour options
    viable_sorted: list[dict[str, Any]] = []
    detours = [v for v in viable if v["id"] != "direct"]
    direct = [v for v in viable if v["id"] == "direct"]
    viable_sorted = detours[:3] + direct[:1]

    # crowd-forecast around the first conflict point (or current pos if no conflict)
    around_lat, around_lon = (future_enc[0]["lat"], future_enc[0]["lon"]) if future_enc else (cur_lat, cur_lon)
    crowd = crowd_signal(scenario_id, around_lat, around_lon, t, alt_ft)

    # historical analogs (only if there's a conflict)
    if future_enc:
        analogs = find_analogs(refc_for_query, retop_for_query, alt_ft, k=24)
    else:
        analogs = []
    summary = analog_summary(analogs)

    # fuel reserve view
    filed_total = float(cumulative_distances_nm(fl["lats"], fl["lons"])[-1])
    flown_so_far = (filed_total - filed_remaining_dist) if phase == "cruise" else 0.0
    fuel_at_start = planned_fuel_load_lb(filed_total, aircraft_type, alt_ft)
    fuel_burned = fuel_burn_lb(max(0.0, flown_so_far), aircraft_type, alt_ft)
    fuel_remaining = fuel_at_start - fuel_burned

    # pick a recommendation
    recommended = viable_sorted[0] if viable_sorted else None
    # delta vs filed direct
    direct_eval: dict[str, Any] | None = None
    for v in viable + rejected:
        if v.get("id") == "direct":
            direct_eval = v
            break

    if recommended and direct_eval and recommended["id"] != "direct":
        rec_view = {
            "id": recommended["id"], "label": recommended["label"],
            "distance_nm": recommended["distance_nm"], "time_min": recommended["time_min"],
            "fuel_lb": recommended["fuel_lb"],
            "fuel_delta_lb": round(recommended["fuel_lb"] - direct_eval.get("fuel_lb", recommended["fuel_lb"]), 0),
            "time_delta_min": round(recommended["time_min"] - direct_eval.get("time_min", recommended["time_min"]), 1),
        }
    elif recommended:
        rec_view = {
            "id": recommended["id"], "label": recommended["label"],
            "distance_nm": recommended["distance_nm"], "time_min": recommended["time_min"],
            "fuel_lb": recommended["fuel_lb"], "fuel_delta_lb": 0, "time_delta_min": 0,
        }
    else:
        rec_view = None

    # landing weather
    metar = landing_assessment(fl["destination_airport_icao"], t.isoformat())

    confidence = "HIGH" if summary["count"] >= 12 else "MEDIUM" if summary["count"] >= 4 else "LOW"

    payload = {
        "flight": {
            "callsign": callsign,
            "aircraft_type": aircraft_type,
            "origin": fl["origin_airport_icao"],
            "destination": fl["destination_airport_icao"],
            "altitude_ft": alt_ft,
            "cruise_kt": cruise_kt,
            "current_position": {"lat": cur_lat, "lon": cur_lon, "phase": phase},
            "filed_route": {"lats": fl["lats"].tolist(), "lons": fl["lons"].tolist()},
        },
        "current_sector": cur_sector,
        "weather_summary": weather_summary,
        "encounters_ahead": future_enc[:6],
        "options": [
            {
                "id": v["id"], "label": v["label"], "lats": v["lats"], "lons": v["lons"],
                "distance_nm": v["distance_nm"], "time_min": v["time_min"],
                "fuel_lb": v["fuel_lb"], "weather_encounters": v["weather_encounters"],
                "max_refc_dbz": v.get("max_refc_dbz"), "sector_violations": v["sector_violations"],
                "sectors_transited": v.get("sectors_transited", []),
                "max_sector_load_pct": v.get("max_sector_load_pct", 0),
            }
            for v in viable_sorted
        ],
        "rejected": rejected,
        "recommended_route": rec_view,
        "crowd_signal": crowd,
        "analogs": {
            **summary,
            "records_preview": analogs[:6],
        },
        "fuel": {
            "estimated_at_start_lb": round(fuel_at_start, 0),
            "burned_so_far_lb": round(fuel_burned, 0),
            "remaining_lb": round(fuel_remaining, 0),
            "reserve_lb": round(fuel_at_start - planned_fuel_load_lb(filed_total / 1.4, aircraft_type, alt_ft), 0),
        },
        "landing_weather": metar,
        "confidence": confidence,
        "time": t.isoformat(),
        "scenario": scenario_id,
    }

    payload["briefing"] = generate_briefing(payload)
    return payload
