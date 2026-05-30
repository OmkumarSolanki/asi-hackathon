#!/usr/bin/env python3
"""Web backend for the "Don't Crash!" course-corrections dashboard.

Reuses the routing / weather / sector logic in ``dont_crash.py`` and exposes it
as JSON (plus a weather raster PNG) for the dark cockpit UI in ``web/``.

Endpoints:
    /api/flights?date=&q=          list dates + (filtered) flight numbers
    /api/flight?flight=&date=      static flight meta + filed route (fast)
    /api/state?flight=&date=&time= time-dependent state: traffic, sectors, wx
    /api/reroutes?flight=&date=&time=   on-demand A* reroutes from that point
    /api/weather.png?date=&time=   NEXRAD-style raster
    /api/version                   hot-reload signal

Run:
    .venv/bin/python webapp.py            # http://127.0.0.1:5000
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory

import dont_crash as dc

# The advisory feature modules (briefing, crowd-forecast, PIREP analogs, METAR,
# winds, fuel) live in the ``backend/app`` package merged in from the FastAPI
# version. They use absolute ``app.*`` imports, so put ``backend/`` on sys.path
# and import them lazily inside the endpoints (keeps startup cheap and resilient
# if an optional dep like ``anthropic`` is missing).
sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

BUNDLE = os.environ.get("BUNDLE", "hackathon_data_bundle")
FUEL_LB_PER_NM = 13.0            # legacy flat fallback; real burn comes from fuel.py
RESERVE_FUEL_LB = 8000.0
TRAFFIC_CORRIDOR_DEG = 0.55
TRAFFIC_MAX = 180

# Cache for the on-demand advisory bundle (brief + crowd + analogs + landing),
# keyed like the reroute cache so re-opening the panel at a point is instant.
_ADVISORY_CACHE = {}

app = Flask(__name__, static_folder="web/static", static_url_path="/static")

_SECTORS = None
_ROUTES_CACHE = {}
_REROUTE_CACHE = {}              # (flight, date, minute) -> reroutes JSON
_CACHE_LOCK = threading.Lock()


def sectors():
    global _SECTORS
    if _SECTORS is None:
        _SECTORS = dc.load_sectors(BUNDLE)
    return _SECTORS


def get_payload(snapshot_dir):
    if snapshot_dir not in _ROUTES_CACHE:
        _ROUTES_CACHE[snapshot_dir] = dc.load_routes(snapshot_dir)
    return _ROUTES_CACHE[snapshot_dir]


# --------------------------------------------------------------------------
# Synthetic-but-deterministic flavour (data has no fix names / aircraft type)
# --------------------------------------------------------------------------
def fix_name(lat, lon):
    h = hashlib.md5(f"{lat:.3f},{lon:.3f}".encode()).digest()
    cons, vow = "BCDFGHJKLMNPRSTVWXZ", "AEIOU"
    pattern = (cons, vow, cons, cons, vow)
    return "".join(p[h[i] % len(p)] for i, p in enumerate(pattern))


AIRCRAFT_TYPES = ["B738", "A320", "B739", "A321", "E75L", "B752", "A319", "CRJ9"]


def aircraft_type(flight_number):
    h = int(hashlib.md5(flight_number.encode()).hexdigest(), 16)
    return AIRCRAFT_TYPES[h % len(AIRCRAFT_TYPES)]


def severity_label(dbz):
    if dbz < 20:
        return "SMOOTH"
    if dbz < 30:
        return "SMTH-LGT"
    if dbz < 40:
        return "LIGHT"
    if dbz < 48:
        return "LGT-MOD"
    if dbz < 55:
        return "MOD"
    return "SEV"


def compass_heading(display_deg):
    return (90.0 - display_deg) % 360.0


def sample_max(lats, lons, grid, step_nm=8.0):
    if grid is None:
        return 0.0
    peak = 0.0
    for i in range(len(lats) - 1):
        seg = dc.haversine_nm(lats[i], lons[i], lats[i + 1], lons[i + 1])
        steps = max(1, int(seg / step_nm))
        for s in range(steps + 1):
            t = s / steps
            la = lats[i] + t * (lats[i + 1] - lats[i])
            lo = lons[i] + t * (lons[i + 1] - lons[i])
            gi, gj = dc.latlon_to_ij(la, lo)
            peak = max(peak, float(grid[gi, gj]))
    return peak


def traffic_on_path(lats, lons, traffic):
    n = 0
    for t in traffic:
        for i in range(0, len(lats), 2):
            if abs(lats[i] - t["lat"]) < TRAFFIC_CORRIDOR_DEG and \
               abs(lons[i] - t["lon"]) < TRAFFIC_CORRIDOR_DEG:
                n += 1
                break
    return n


def compute_traffic(flights, flight, current_time):
    out = []
    for fl in flights:
        if fl is flight:
            continue
        la, lo = fl.get("lats"), fl.get("lons")
        if not la or len(la) < 2:
            continue
        f2 = dc.flight_fraction(fl, current_time)
        if f2 <= 0 or f2 >= 1:
            continue
        tlat, tlon, thead, *_ = dc.split_at_fraction(la, lo, f2)
        out.append({"lat": round(tlat, 3), "lon": round(tlon, 3),
                    "hdg": round(compass_heading(thead))})
        if len(out) >= TRAFFIC_MAX:
            break
    return out


def compute_overload(flights, flight, current_time):
    secs = sectors()
    if not secs:
        return [], None
    loads = dc.compute_sector_loads(flights, current_time, secs)
    band = dc.flight_band(flight.get("cruise_altitude_ft") or 0)
    over = dc.overloaded_in_band(secs, loads, band)
    mask = dc.overload_mask_grid(over) if over else None
    return over, mask


def sectors_json(over):
    return [{"name": s["name"], "load": s["load"], "cap": s["cap"],
             "ring": [[round(y, 3), round(x, 3)] for x, y in s["geom"].exterior.coords]}
            for s in over]


# --------------------------------------------------------------------------
# NEXRAD-style colormap
# --------------------------------------------------------------------------
_CMAP_STOPS = [
    (8, (40, 70, 35)), (18, (80, 140, 40)), (28, (180, 200, 40)),
    (35, (235, 200, 45)), (42, (240, 150, 30)), (50, (220, 45, 30)),
    (58, (190, 30, 120)), (68, (240, 160, 220)),
]


def weather_rgba(refc):
    m = np.where(refc <= -50, np.nan, refc)
    xs = np.array([s[0] for s in _CMAP_STOPS], float)
    base = np.nan_to_num(m, nan=0.0)
    r = np.interp(base, xs, [s[1][0] for s in _CMAP_STOPS])
    g = np.interp(base, xs, [s[1][1] for s in _CMAP_STOPS])
    b = np.interp(base, xs, [s[1][2] for s in _CMAP_STOPS])
    alpha = np.clip((np.nan_to_num(m, nan=-100) - 8.0) / 14.0, 0.0, 1.0) * 235.0
    rgba = np.zeros((*refc.shape, 4), dtype=np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = r, g, b
    rgba[..., 3] = alpha.astype(np.uint8)
    return rgba


def _native(o):
    if isinstance(o, dict):
        return {k: _native(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_native(v) for v in o]
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    return o


# --------------------------------------------------------------------------
# Advisory bridge — map haxney's (flight, date, time) world onto the merged
# ``app.*`` services, which key everything by scenario_id + tz-aware UTC time.
# --------------------------------------------------------------------------
def _scenario_id(snapshot_dir):
    """``…/asked_at_2025-07-08T22:00:00Z`` -> ``2025-07-08T22:00:00Z`` (what the
    app.core loaders expect)."""
    name = os.path.basename(str(snapshot_dir).rstrip("/"))
    return name[len("asked_at_"):] if name.startswith("asked_at_") else name


def _utc(dt):
    """Normalize a (possibly naive) datetime to tz-aware UTC, since the services
    compare against tz-aware weather/route timestamps."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _burn_rate(flight):
    """Aircraft-aware fuel burn (lb/nm) from the OpenAP-backed fuel model, with a
    graceful fall back to the legacy flat rate."""
    try:
        from app.services import fuel
        atype = fuel.aircraft_type_for(flight["flight_number"])
        return fuel.burn_rate_lb_per_nm(atype, float(flight.get("cruise_altitude_ft") or 36000))
    except Exception:
        return FUEL_LB_PER_NM


def _worst_encounter(scenario_id, lats, lons, alt_ft, ct, step_nm=25.0):
    """Walk a route and return the hottest weather point: (lat, lon, refc, retop).
    refc/retop are sampled via the same simulator the analog archive uses so the
    k-NN lookup is consistent. Returns the route midpoint with refc=0 if clear."""
    from app.core.simulator import sample_wx_at
    best = None
    for i in range(len(lats) - 1):
        seg = dc.haversine_nm(lats[i], lons[i], lats[i + 1], lons[i + 1])
        steps = max(1, int(seg / step_nm))
        for s in range(steps + 1):
            t = s / steps
            la = lats[i] + t * (lats[i + 1] - lats[i])
            lo = lons[i] + t * (lons[i + 1] - lons[i])
            refc = sample_wx_at(scenario_id, "refc", la, lo, ct)
            if refc is None:
                continue
            if best is None or refc > best[2]:
                retop = sample_wx_at(scenario_id, "retop", la, lo, ct)
                best = (la, lo, float(refc), retop)
    if best is None:
        mid = len(lats) // 2
        return float(lats[mid]), float(lons[mid]), 0.0, None
    return best


def _confidence(analog_count):
    if analog_count >= 12:
        return "HIGH"
    if analog_count >= 4:
        return "MEDIUM"
    return "LOW"


# --------------------------------------------------------------------------
# Resolution helpers
# --------------------------------------------------------------------------
def _resolve(flight_number, date, time_arg, need_time=True):
    sd = dc.find_snapshot_dir(BUNDLE, date)
    if sd is None:
        return None, ({"error": f"no snapshot for date {date!r}",
                       "dates": dc.available_dates(BUNDLE)}, 404)
    payload = get_payload(sd)
    matches = dc.find_flights(payload.get("flights", []), flight_number)
    if not matches:
        return None, ({"error": f"flight {flight_number!r} not found"}, 404)
    flight = matches[0]
    ct = None
    if need_time:
        try:
            ct = dc.parse_current_time(time_arg, flight)
        except ValueError:
            return None, ({"error": f"bad time {time_arg!r}"}, 400)
        if ct is None:
            ct = datetime.fromisoformat(flight["take_off_time"])
    return {"sd": sd, "payload": payload, "flight": flight, "ct": ct}, None


# --------------------------------------------------------------------------
# Endpoint computations
# --------------------------------------------------------------------------
def flight_meta(flight_number, date):
    ctx, err = _resolve(flight_number, date, None, need_time=False)
    if err:
        return err
    f = ctx["flight"]
    lats, lons = f["lats"], f["lons"]
    t0 = datetime.fromisoformat(f["take_off_time"])
    t1 = datetime.fromisoformat(f["scheduled_landing_time"])
    cruise = f.get("cruise_altitude_ft") or 0
    names = [fix_name(la, lo) for la, lo in zip(lats, lons)]
    names[0] = f.get("origin_airport_icao") or names[0]
    names[-1] = f.get("destination_airport_icao") or names[-1]
    try:
        from app.services import fuel as _fuel
        atype = _fuel.aircraft_type_for(f["flight_number"])
    except Exception:
        atype = aircraft_type(f["flight_number"])
    burn = _burn_rate(f)
    return {
        "flight": {
            "callsign": f["flight_number"], "type": atype,
            "origin": f.get("origin_airport_icao"), "dest": f.get("destination_airport_icao"),
            "altFL": f"FL{int(cruise) // 100:03d}", "gsKt": int(f.get("cruise_speed_kt") or 450),
        },
        "filed": [[round(a, 4), round(b, 4)] for a, b in zip(lats, lons)],
        "fixNames": names,
        "takeoffIso": f["take_off_time"], "landingIso": f["scheduled_landing_time"],
        "takeoffZ": f["take_off_time"][11:16], "landingZ": f["scheduled_landing_time"][11:16],
        "durationMin": int((t1 - t0).total_seconds() / 60),
        "extent": [round(v, 3) for v in dc.view_extent([(lats, lons)], pad_frac=0.12)],
        "weatherExtent": dc.WX_EXTENT, "nowcastMin": dc.LOOKAHEAD_MIN,
        "radarAlt": f"FL{int(cruise) // 100:03d}",
        "fuelPerNm": round(burn, 2), "reserveFuel": RESERVE_FUEL_LB,
    }, 200


def state(flight_number, date, time_arg):
    ctx, err = _resolve(flight_number, date, time_arg)
    if err:
        return err
    f, ct = ctx["flight"], ctx["ct"]
    flights = ctx["payload"]["flights"]
    lats, lons = f["lats"], f["lons"]
    cruise = f.get("cruise_altitude_ft") or 0
    speed = f.get("cruise_speed_kt") or 450

    frac = dc.flight_fraction(f, ct)
    plat, plon, heading, flown, remaining = dc.split_at_fraction(lats, lons, frac)
    remaining_nm = dc.polyline_length_nm(remaining[0], remaining[1])

    refc = dc.load_wx_matrix(ctx["sd"], ct, "refc")
    refc_grid = refc[0] if refc else None
    filed_dbz = sample_max(remaining[0], remaining[1], refc_grid)

    traffic = compute_traffic(flights, f, ct)
    over, _ = compute_overload(flights, f, ct)

    next_lat = remaining[0][1] if len(remaining[0]) > 1 else lats[-1]
    next_lon = remaining[1][1] if len(remaining[1]) > 1 else lons[-1]
    fuel_now = remaining_nm * _burn_rate(f) + RESERVE_FUEL_LB
    sigmet = None
    if filed_dbz >= 40:
        sigmet = {"id": f"{int(filed_dbz) % 90 + 10}C", "worstDbz": round(filed_dbz),
                  "fix": fix_name(next_lat, next_lon),
                  "tops": f"FL{int(450 + (int(filed_dbz) % 6) * 10)}"}

    return {
        "plane": {"lat": round(plat, 4), "lon": round(plon, 4),
                  "hdg": round(compass_heading(heading), 1)},
        "frac": round(frac, 4),
        "nowZ": ct.strftime("%H:%M"),
        "traffic": traffic,
        "overloadSectors": sectors_json(over),
        "filed": {"worstDbz": round(filed_dbz), "sevLabel": severity_label(filed_dbz)},
        "sigmet": sigmet,
        "readouts": {
            "hdg": int(round(compass_heading(heading))),
            "nextFix": fix_name(next_lat, next_lon),
            "fuelText": f"{fuel_now / 1000:.1f}k lb",
            "etaZ": f["scheduled_landing_time"][11:16],
        },
    }, 200


def traffic_only(flight_number, date, time_arg):
    """Just the other-aircraft positions at a time — cheap enough to call live
    while the user drags the timeline (no sector/weather work)."""
    ctx, err = _resolve(flight_number, date, time_arg)
    if err:
        return err
    f, ct = ctx["flight"], ctx["ct"]
    return {"traffic": compute_traffic(ctx["payload"]["flights"], f, ct),
            "nowZ": ct.strftime("%H:%M")}, 200


def reroutes_compute(flight_number, date, time_arg):
    ctx, err = _resolve(flight_number, date, time_arg)
    if err:
        return err
    f, ct = ctx["flight"], ctx["ct"]
    # Cache A* results by (flight, date, minute) so re-display / revisits are instant.
    cache_key = (f["flight_number"], date, ct.strftime("%Y-%m-%dT%H:%M"))
    with _CACHE_LOCK:
        if cache_key in _REROUTE_CACHE:
            return _REROUTE_CACHE[cache_key], 200
    flights = ctx["payload"]["flights"]
    lats, lons = f["lats"], f["lons"]
    cruise = f.get("cruise_altitude_ft") or 0
    speed = f.get("cruise_speed_kt") or 450

    frac = dc.flight_fraction(f, ct)
    plat, plon, heading, flown, remaining = dc.split_at_fraction(lats, lons, frac)
    dest_ll = (lats[-1], lons[-1])
    remaining_nm = dc.polyline_length_nm(remaining[0], remaining[1])

    refc = dc.load_wx_matrix(ctx["sd"], ct, "refc")
    refc_grid = refc[0] if refc else None
    severity = dc.lookahead_severity_grid(ctx["sd"], ct, cruise)
    over, mask = compute_overload(flights, f, ct)
    traffic = compute_traffic(flights, f, ct)

    route_sev = severity if remaining_nm > 10 else None
    routes = dc.build_routes((plat, plon), dest_ll, remaining, route_sev, mask)
    _, goodness = dc.score_routes([r["metrics"] for r in routes])
    baseline = routes[0]["metrics"].distance_nm
    burn = _burn_rate(f)

    def coords(r):
        return [[round(a, 4), round(b, 4)] for a, b in zip(r["lats"], r["lons"])]

    filed_dbz = sample_max(remaining[0], remaining[1], refc_grid)
    out = []
    used_names = set()
    for idx, r in enumerate(routes[1:], start=1):
        m = r["metrics"]
        extra = m.distance_nm - baseline
        dbz = sample_max(r["lats"], r["lons"], refc_grid)
        # Name each reroute after a fix along it; try several positions so paths
        # that cross at one waypoint still get distinct names.
        n = len(r["lats"])
        name = None
        for pos in (n // 2, n // 3, 2 * n // 3, n // 4):
            cand = fix_name(r["lats"][pos], r["lons"][pos])
            if cand not in used_names:
                name = cand
                break
        if name is None:                       # last resort: nudge until unique
            base = fix_name(r["lats"][n // 2], r["lons"][n // 2])
            name = base
            k = 1
            while name in used_names:
                name = base[:-1] + "AEIOUY"[k % 6]
                k += 1
        used_names.add(name)
        out.append({
            "name": name, "coords": coords(r),
            "addFuelLb": round(max(0.0, extra) * burn),
            "addTimeMin": round(max(0.0, extra) / speed * 60),
            "worstDbz": round(dbz), "sevLabel": severity_label(dbz),
            "aircraft": traffic_on_path(r["lats"], r["lons"], traffic),
            "entersOverload": bool(m.sector_overload_nm > 1.0),
            "distNm": round(m.distance_nm), "extraNm": round(extra),
            "goodness": float(goodness[idx]),
        })
    # Drop near-identical reroutes (the fan can produce overlapping paths),
    # keeping the better-scoring one so the list shows visually distinct options.
    def sig(r):
        c = r["coords"][len(r["coords"]) // 2]
        return (round(c[0], 1), round(c[1], 1), round(r["distNm"] / 25))
    uniq, seen = [], {}
    for r in out:
        k = sig(r)
        if k in seen:
            if r["goodness"] > seen[k]["goodness"]:
                uniq[uniq.index(seen[k])] = r
                seen[k] = r
            continue
        seen[k] = r
        uniq.append(r)
    out = uniq

    clear = [r for r in out if not r["entersOverload"]]
    reco = max(clear or out, key=lambda r: r["goodness"], default=None)
    for r in out:
        r["recommended"] = (r is reco)
    out.sort(key=lambda r: (not r["recommended"], r["addFuelLb"]))

    result = {
        "filed": {"name": fix_name(*dest_ll), "worstDbz": round(filed_dbz),
                  "sevLabel": severity_label(filed_dbz), "distNm": round(baseline)},
        "reroutes": out, "count": len(out),
        "remainingNm": round(remaining_nm),
    }
    with _CACHE_LOCK:
        _REROUTE_CACHE[cache_key] = result
    return result, 200


def find_hotspot(flight_number, date):
    """Frac/time of the most congested point on the filed track — where the
    plane meets weather and/or an over-demand sector — a good place to
    pre-evaluate reroutes."""
    ctx, err = _resolve(flight_number, date, None, need_time=False)
    if err:
        return err
    f = ctx["flight"]
    flights = ctx["payload"]["flights"]
    lats, lons = f["lats"], f["lons"]
    t0 = datetime.fromisoformat(f["take_off_time"])
    t1 = datetime.fromisoformat(f["scheduled_landing_time"])

    best = None
    # Sector occupancy is time-dependent, so evaluate overload at each sampled
    # point's own time (not a single snapshot).
    for k in range(3, 18, 2):                   # fracs 0.15 .. 0.85
        frac = k / 20.0
        ct = t0 + (t1 - t0) * frac
        _, _, _, _, remaining = dc.split_at_fraction(lats, lons, frac)
        refc = dc.load_wx_matrix(ctx["sd"], ct, "refc")
        peak = sample_max(remaining[0], remaining[1], refc[0]) if refc else 0.0
        _, mask = compute_overload(flights, f, ct)
        over_hit = (dc.severity_along(remaining[0], remaining[1], mask.astype(float))
                    if mask is not None else 0.0)
        reason = "sector" if over_hit > 1 else ("weather" if peak >= 25 else None)
        trouble = peak + (250 if over_hit > 1 else 0)
        if reason and (best is None or trouble > best[0]):
            best = (trouble, frac, ct, reason, round(peak))
    if not best:
        return {"found": False}, 200
    _, frac, ct, reason, dbz = best
    return {"found": True, "frac": round(frac, 3), "timeIso": ct.isoformat(),
            "timeZ": ct.strftime("%H:%M"), "worstDbz": dbz, "reason": reason}, 200


# --------------------------------------------------------------------------
# Advisory feature computations (crowd-forecast, PIREP analogs, landing METAR,
# winds, AI briefing) — built on top of haxney's flight state, not replacing the
# A* route planning.
# --------------------------------------------------------------------------
def _encounter_ctx(flight_number, date, time_arg):
    """Resolve the flight + the hottest weather point on its remaining filed
    route at the current time. Shared by the crowd / analogs / briefing endpoints."""
    ctx, err = _resolve(flight_number, date, time_arg)
    if err:
        return None, err
    f, ct = ctx["flight"], _utc(ctx["ct"])
    lats, lons = f["lats"], f["lons"]
    alt = float(f.get("cruise_altitude_ft") or 36000)
    frac = dc.flight_fraction(f, ctx["ct"])
    plat, plon, _, _, remaining = dc.split_at_fraction(lats, lons, frac)
    sid = _scenario_id(ctx["sd"])
    enc_lat, enc_lon, refc, retop = _worst_encounter(
        sid, remaining[0], remaining[1], alt, ct)
    if refc < dc.HAZARD_DBZ:                  # no real hazard ahead → use plane pos
        enc_lat, enc_lon = plat, plon
    return {
        "ctx": ctx, "sid": sid, "ct": ct, "alt": alt,
        "enc_lat": enc_lat, "enc_lon": enc_lon, "refc": refc, "retop": retop,
    }, None


def crowd_compute(flight_number, date, time_arg):
    info, err = _encounter_ctx(flight_number, date, time_arg)
    if err:
        return err
    from app.services.crowd_forecast import crowd_signal
    sig = crowd_signal(info["sid"], info["enc_lat"], info["enc_lon"],
                       info["ct"], info["alt"])
    sig["at"] = {"lat": round(info["enc_lat"], 3), "lon": round(info["enc_lon"], 3),
                 "refc": round(info["refc"])}
    return sig, 200


def analogs_compute(flight_number, date, time_arg):
    info, err = _encounter_ctx(flight_number, date, time_arg)
    if err:
        return err
    from app.services.pirep import find_analogs, analog_summary
    analogs = find_analogs(info["refc"], info["retop"], info["alt"], k=24)
    summary = analog_summary(analogs)
    summary["encounter"] = {"refc": round(info["refc"]),
                            "retop": round(info["retop"]) if info["retop"] else None}
    summary["preview"] = [
        {"scenario": a["scenario"], "flight": a["flight"],
         "origin": a["origin"], "destination": a["destination"],
         "refc": a["refc_dbz"], "similarity": a["similarity"]}
        for a in analogs[:5]
    ]
    return summary, 200


def landing_compute(flight_number, date, time_arg):
    ctx, err = _resolve(flight_number, date, time_arg)
    if err:
        return err
    f = ctx["flight"]
    dest = f.get("destination_airport_icao")
    if not dest:
        return {"available": False, "note": "No destination airport on file."}, 200
    from app.services.metar import landing_assessment
    return landing_assessment(dest, _utc(ctx["ct"]).isoformat()), 200


def winds_compute(date, time_arg):
    sd = dc.find_snapshot_dir(BUNDLE, date)
    if sd is None:
        return {"error": f"no snapshot for date {date!r}"}, 404
    payload = get_payload(sd)
    ref = payload["flights"][0] if payload.get("flights") else {}
    try:
        t = dc.parse_current_time(time_arg, ref) if time_arg else None
    except ValueError:
        t = None
    if t is None:
        t = datetime.fromisoformat(payload["asked_at"])
    from app.services.winds import fetch_winds
    return fetch_winds(_utc(t).isoformat()), 200


def advisory_compute(flight_number, date, time_arg):
    """Aggregate everything the cockpit's ADVISORY panel needs in one shot:
    the AI briefing plus the crowd / analogs / landing / fuel context it is
    grounded in. Cached per (flight, date, minute) — it calls Claude."""
    ctx, err = _resolve(flight_number, date, time_arg)
    if err:
        return err
    f, ct = ctx["flight"], ctx["ct"]
    cache_key = (f["flight_number"], date, ct.strftime("%Y-%m-%dT%H:%M"))
    with _CACHE_LOCK:
        if cache_key in _ADVISORY_CACHE:
            return _ADVISORY_CACHE[cache_key], 200

    crowd, _ = crowd_compute(flight_number, date, time_arg)
    analogs, _ = analogs_compute(flight_number, date, time_arg)
    landing, _ = landing_compute(flight_number, date, time_arg)
    reroutes, _ = reroutes_compute(flight_number, date, time_arg)
    reco = next((r for r in reroutes.get("reroutes", []) if r.get("recommended")), None)

    remaining_nm = reroutes.get("remainingNm", 0)
    burn = _burn_rate(f)
    try:
        from app.services import fuel as _fuel
        atype = _fuel.aircraft_type_for(f["flight_number"])
    except Exception:
        atype = aircraft_type(f["flight_number"])
    fuel = {
        "type": atype,
        "remaining_lb": round(remaining_nm * burn + RESERVE_FUEL_LB),
        "reserve_lb": RESERVE_FUEL_LB,
        "burn_lb_per_nm": round(burn, 2),
    }

    filed = reroutes.get("filed", {})
    confidence = _confidence(analogs.get("count", 0))
    rec_payload = None
    if reco:
        rec_payload = {"label": f"reroute via {reco['name']}",
                       "fuel_delta_lb": reco["addFuelLb"],
                       "time_delta_min": reco["addTimeMin"],
                       "distance_nm": reco["distNm"]}
    payload = {
        "flight": {
            "callsign": f["flight_number"],
            "aircraft_type": fuel["type"],
            "origin": f.get("origin_airport_icao"),
            "destination": f.get("destination_airport_icao"),
            "altitude_ft": f.get("cruise_altitude_ft"),
            "cruise_kt": f.get("cruise_speed_kt"),
        },
        "weather_summary": (f"{filed.get('sevLabel','SMOOTH')} on filed route, "
                            f"peak {filed.get('worstDbz',0)} dBZ"),
        "recommended_route": rec_payload,
        "crowd_signal": crowd,
        "analogs": analogs,
        "fuel": fuel,
        "landing_weather": landing,
        "confidence": confidence,
        "time": _utc(ct).isoformat(),
        "scenario": _scenario_id(ctx["sd"]),
    }
    from app.services.briefing import generate_briefing
    brief = generate_briefing(payload)

    result = {
        "brief": brief,
        "confidence": confidence,
        "crowd": crowd,
        "analogs": analogs,
        "landing": landing,
        "fuel": fuel,
        "recommended": rec_payload,
        "weatherSummary": payload["weather_summary"],
    }
    with _CACHE_LOCK:
        _ADVISORY_CACHE[cache_key] = result
    return result, 200


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory("web", "index.html")


@app.route("/api/flights")
def api_flights():
    date = request.args.get("date", "")
    q = (request.args.get("q") or "").upper()
    dates = dc.available_dates(BUNDLE)
    sd = dc.find_snapshot_dir(BUNDLE, date) if date else None
    flights = []
    if sd:
        nums = sorted({f["flight_number"] for f in get_payload(sd).get("flights", [])})
        flights = [n for n in nums if q in n.upper()][:80] if q else nums[:80]
    return jsonify({"dates": dates, "flights": flights})


@app.route("/api/flight")
def api_flight():
    data, status = flight_meta(request.args.get("flight", ""),
                               request.args.get("date", ""))
    return jsonify(_native(data)), status


@app.route("/api/state")
def api_state():
    data, status = state(request.args.get("flight", ""),
                         request.args.get("date", ""),
                         request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/traffic")
def api_traffic():
    data, status = traffic_only(request.args.get("flight", ""),
                                request.args.get("date", ""),
                                request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/reroutes")
def api_reroutes():
    data, status = reroutes_compute(request.args.get("flight", ""),
                                    request.args.get("date", ""),
                                    request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/hotspot")
def api_hotspot():
    flight = request.args.get("flight", "")
    date = request.args.get("date", "")
    data, status = find_hotspot(flight, date)
    if status == 200 and data.get("found"):
        # Pre-warm the reroute cache for that point in the background so it's
        # ready the moment the user scrubs there. Does not block this response.
        t = data["timeIso"]
        threading.Thread(target=lambda: reroutes_compute(flight, date, t),
                         daemon=True).start()
    return jsonify(_native(data)), status


@app.route("/api/crowd")
def api_crowd():
    data, status = crowd_compute(request.args.get("flight", ""),
                                 request.args.get("date", ""),
                                 request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/analogs")
def api_analogs():
    data, status = analogs_compute(request.args.get("flight", ""),
                                   request.args.get("date", ""),
                                   request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/landing")
def api_landing():
    data, status = landing_compute(request.args.get("flight", ""),
                                   request.args.get("date", ""),
                                   request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/winds")
def api_winds():
    data, status = winds_compute(request.args.get("date", ""),
                                 request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/advisory")
def api_advisory():
    data, status = advisory_compute(request.args.get("flight", ""),
                                    request.args.get("date", ""),
                                    request.args.get("time", ""))
    return jsonify(_native(data)), status


@app.route("/api/weather.png")
def api_weather():
    date = request.args.get("date", "")
    time_arg = request.args.get("time", "")
    sd = dc.find_snapshot_dir(BUNDLE, date)
    if sd is None:
        return ("no snapshot", 404)
    payload = get_payload(sd)
    ref = payload["flights"][0] if payload.get("flights") else {}
    try:
        t = dc.parse_current_time(time_arg, ref) if time_arg else None
    except ValueError:
        t = None
    if t is None:
        t = datetime.fromisoformat(payload["asked_at"])
    refc = dc.load_wx_matrix(sd, t, "refc")
    if refc is None:
        return ("no weather", 404)
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(weather_rgba(refc[0]), "RGBA").save(buf, "PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@app.route("/api/version")
def api_version():
    paths = []
    for root in ("web", "webapp.py", "dont_crash.py"):
        if os.path.isfile(root):
            paths.append(root)
        else:
            for dp, _, fns in os.walk(root):
                paths += [os.path.join(dp, fn) for fn in fns]
    mt = max((os.path.getmtime(p) for p in paths if os.path.exists(p)), default=0)
    return jsonify({"version": round(mt, 2)})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)),
            debug=True, use_reloader=True)
