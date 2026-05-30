#!/usr/bin/env python3
"""Find good demo flights.

A "good" demo flight is one whose *filed* route runs into trouble the app will
react to — hazardous convective weather (refc >= 40 dBZ with echo tops above the
cruise altitude) and/or an over-demand ATC sector (more flights in the sector
than its capacity at the time the flight is there). Those are exactly the
conditions that make the cockpit propose reroutes, so they make the best demos.

It reuses the merged advisory engine in ``backend/app`` (the same simulator the
web app uses), so the signal matches what you'll see in the UI.

Usage:
    python scripts/find_demo_flights.py                     # scan all scenarios
    python scripts/find_demo_flights.py --top 20
    python scripts/find_demo_flights.py --scenario 2025-07-08T22:00:00Z
    python scripts/find_demo_flights.py --require both      # weather AND sectors
    python scripts/find_demo_flights.py --base http://127.0.0.1:5000

Output is a ranked table plus ready-to-open demo URLs.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from functools import lru_cache
from pathlib import Path

# Make the merged `app` package importable (same trick webapp.py uses).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.core.loaders import list_scenarios, load_routes, load_sectors  # noqa: E402
from app.core.simulator import (  # noqa: E402
    REFC_HAZARD_DBZ,
    flight_position_at,
    flight_weather_encounters,
    sector_for,
    sector_loads_at,
)


@lru_cache(maxsize=1)
def _capacity() -> dict[str, float]:
    caps: dict[str, float] = {}
    for f in load_sectors()["features"]:
        p = f["properties"]
        if p.get("capacity") is not None:
            caps[p["name"]] = float(p["capacity"])
    return caps


def _round(t: datetime, step_min: int = 15) -> datetime:
    return t.replace(minute=(t.minute // step_min) * step_min, second=0, microsecond=0)


@lru_cache(maxsize=4096)
def _loads_at(sid: str, t_iso: str) -> dict[str, int]:
    """Sector occupancy at a 15-min-rounded time, cached so all flights in a
    scenario share the (expensive) all-flights count."""
    return sector_loads_at(sid, datetime.fromisoformat(t_iso))


def sector_trouble(sid: str, flight: dict, step_min: int = 15) -> dict:
    """How hard the filed route presses on over-demand sectors."""
    caps = _capacity()
    t0, t1 = flight["take_off_time_dt"], flight["scheduled_landing_time_dt"]
    total = (t1 - t0).total_seconds() / 60.0
    out = {"hits": 0, "max_load_pct": 0.0, "sectors": set(), "worst_time": None}
    if total <= 0:
        return out
    n = max(2, int(total / step_min))
    alt = float(flight["cruise_altitude_ft"])
    for i in range(1, n):
        t = t0 + (t1 - t0) * (i / n)
        pos = flight_position_at(flight, t)
        if pos is None or pos[2] != "cruise":
            continue
        sec = sector_for(pos[0], pos[1], alt)
        if sec is None:
            continue
        cap = caps.get(sec["name"])
        if not cap:
            continue
        load = _loads_at(sid, _round(t).isoformat()).get(sec["name"], 0)
        pct = 100.0 * load / cap
        if load > cap:
            out["hits"] += 1
            out["sectors"].add(sec["name"])
            if pct > out["max_load_pct"]:
                out["max_load_pct"] = pct
                out["worst_time"] = t
    return out


def weather_trouble(sid: str, flight: dict) -> dict:
    enc = flight_weather_encounters(sid, flight, step_min=10)
    out = {"hits": len(enc), "max_refc": 0.0, "worst_time": None}
    for e in enc:
        if e["refc_dbz"] > out["max_refc"]:
            out["max_refc"] = e["refc_dbz"]
            out["worst_time"] = datetime.fromisoformat(e["time"])
    return out


def score(wx: dict, sec: dict) -> float:
    # Sectors are rarer/more dramatic, so weight them a bit higher than weather.
    return (wx["hits"] * 8.0
            + wx["max_refc"] * 0.4
            + sec["hits"] * 12.0
            + sec["max_load_pct"] * 0.1)


def scan(scenarios: list[str], require: str) -> list[dict]:
    rows: list[dict] = []
    for si, sid in enumerate(scenarios, 1):
        routes = load_routes(sid)
        flights = routes["flights"]
        print(f"  [{si}/{len(scenarios)}] {sid}: {len(flights)} flights …",
              file=sys.stderr, flush=True)
        for fl in flights:
            wx = weather_trouble(sid, fl)
            sec = sector_trouble(sid, fl)
            has_wx, has_sec = wx["hits"] > 0, sec["hits"] > 0
            if require == "weather" and not has_wx:
                continue
            if require == "sectors" and not has_sec:
                continue
            if require == "both" and not (has_wx and has_sec):
                continue
            if require == "any" and not (has_wx or has_sec):
                continue
            worst = wx["worst_time"] or sec["worst_time"]
            rows.append({
                "sid": sid,
                "date": sid[:10],
                "flight": fl["flight_number"],
                "od": f"{fl['origin_airport_icao']}→{fl['destination_airport_icao']}",
                "alt": int(fl["cruise_altitude_ft"]),
                "wx_hits": wx["hits"], "max_refc": round(wx["max_refc"]),
                "sec_hits": sec["hits"], "max_load": round(sec["max_load_pct"]),
                "sectors": ",".join(sorted(sec["sectors"])) or "-",
                "worst": worst,
                "score": round(score(wx, sec), 1),
            })
    rows.sort(key=lambda r: r["score"], reverse=True)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", help="limit to one scenario id (e.g. 2025-07-08T22:00:00Z)")
    ap.add_argument("--top", type=int, default=15, help="rows to print (default 15)")
    ap.add_argument("--require", choices=["any", "weather", "sectors", "both"],
                    default="any", help="qualifying condition (default any)")
    ap.add_argument("--base", default="http://127.0.0.1:5000", help="app base URL for demo links")
    args = ap.parse_args()

    scenarios = [args.scenario] if args.scenario else list_scenarios()
    print(f"Scanning {len(scenarios)} scenario(s) for reroute-worthy flights "
          f"(hazard >= {int(REFC_HAZARD_DBZ)} dBZ and/or over-demand sectors)…",
          file=sys.stderr)
    rows = scan(scenarios, args.require)
    if not rows:
        print("No qualifying flights found.")
        return

    hdr = f"{'#':>2}  {'SCORE':>6}  {'DATE':<10}  {'FLIGHT':<8}  {'O→D':<11}  {'ALT':>6}  {'WX':>3} {'dBZ':>4}  {'SEC':>3} {'LOAD%':>5}  WORST(z)   SECTORS"
    print("\n" + hdr)
    print("-" * len(hdr))
    for i, r in enumerate(rows[:args.top], 1):
        wz = r["worst"].strftime("%H:%M") if r["worst"] else "  -  "
        print(f"{i:>2}  {r['score']:>6}  {r['date']:<10}  {r['flight']:<8}  {r['od']:<11}  "
              f"FL{r['alt']//100:>3}  {r['wx_hits']:>3} {r['max_refc']:>4}  "
              f"{r['sec_hits']:>3} {r['max_load']:>5}  {wz:<8}   {r['sectors']}")

    print("\nTop 5 demo links:")
    for r in rows[:5]:
        t = (r["worst"] or load_routes(r["sid"])["flights"][0]["take_off_time_dt"])
        tiso = t.strftime("%Y-%m-%dT%H:%M")
        why = []
        if r["wx_hits"]:
            why.append(f"{r['wx_hits']} wx hits to {r['max_refc']} dBZ")
        if r["sec_hits"]:
            why.append(f"sector {r['sectors']} at {r['max_load']}%")
        print(f"  • {r['flight']} {r['od']} ({r['date']}) — {'; '.join(why)}")
        print(f"    {args.base}/?flight={r['flight']}&date={r['date']}"
              f"&time={tiso}&suggest=1")


if __name__ == "__main__":
    main()
