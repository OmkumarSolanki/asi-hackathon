"""Scan all 11 scenarios and pick the one with the most dramatic storm story."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json
import numpy as np
from app.core.loaders import (
    list_scenarios, load_routes, list_weather_files, load_wx_frame, latlon_to_wx_ij,
)
from app.core.simulator import REFC_HAZARD_DBZ, flight_position_at
from datetime import timedelta


def score_scenario(sid: str) -> dict:
    routes = load_routes(sid)
    n_flights = len(routes["flights"])
    asked_at = routes["asked_at_dt"]

    # weather drama: average + max hazard fraction across next 6 hours
    refc_files = list_weather_files(sid, "refc")
    window_end = asked_at + timedelta(hours=6)
    window_files = [f for f in refc_files if f["valid_from"] >= asked_at and f["valid_from"] <= window_end][:24]
    if not window_files:
        return {"sid": sid, "score": 0, "n_flights": n_flights, "hazard_frac": 0}

    hazard_fracs = []
    peak = 0.0
    for f in window_files:
        m = load_wx_frame(str(f["path"]))
        m = np.where(m <= -50, np.nan, m)
        hazard = (m >= REFC_HAZARD_DBZ).sum()
        total = np.isfinite(m).sum()
        if total > 0:
            hazard_fracs.append(hazard / total)
            peak = max(peak, float(np.nanmax(m)))
    hazard_frac = float(np.mean(hazard_fracs)) if hazard_fracs else 0.0

    # affected flights: planned routes that pass through any hazard cell in next 2 hrs
    affected = 0
    for fl in routes["flights"]:
        if not fl["is_airborne"]:
            continue
        n_samp = 6
        for i in range(n_samp + 1):
            frac = i / n_samp
            t = fl["take_off_time_dt"] + (fl["scheduled_landing_time_dt"] - fl["take_off_time_dt"]) * frac
            if t < asked_at or t > window_end:
                continue
            pos = flight_position_at(fl, t)
            if pos is None:
                continue
            lat, lon, _ = pos
            ij = latlon_to_wx_ij(lat, lon)
            if ij is None:
                continue
            # match closest wx file
            best = min(window_files, key=lambda x: abs((x["valid_from"] - t).total_seconds()))
            m = load_wx_frame(str(best["path"]))
            v = float(m[ij[0], ij[1]])
            if v >= REFC_HAZARD_DBZ:
                affected += 1
                break

    score = hazard_frac * 1000 + affected * 2 + peak * 0.5
    return {
        "sid": sid,
        "score": round(score, 2),
        "n_flights": n_flights,
        "hazard_frac": round(hazard_frac, 4),
        "peak_refc": round(peak, 1),
        "affected_flights": affected,
    }


def main() -> int:
    sids = list_scenarios()
    print(f"Scanning {len(sids)} scenarios...\n")
    results = []
    for sid in sids:
        r = score_scenario(sid)
        results.append(r)
        print(f"  {sid}: score={r['score']:>8.2f}  flights={r['n_flights']:>5}  hazard%={r['hazard_frac']*100:>5.2f}  peak_refc={r['peak_refc']}  affected={r['affected_flights']}")
    results.sort(key=lambda r: r["score"], reverse=True)
    hero = results[0]
    print(f"\n>>> HERO: {hero['sid']}  (score {hero['score']})")
    out = Path(__file__).resolve().parents[1] / "app" / "data" / "hero.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"hero": hero, "ranking": results}, indent=2))
    print(f"Saved {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
