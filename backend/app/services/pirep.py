from __future__ import annotations

"""PIREP archive: synthetic pilot reports built by replaying every flight in every scenario.

For each flight × every ~10 min along its planned route, we sample the weather at that
position and altitude. If it crosses a hazard cell (refc>=40 AND retop>alt), we log a
PIREP. The archive is keyed by weather signature so we can do k-NN similarity at query time.
"""

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import CACHE_DIR
from app.core.loaders import list_scenarios, load_routes
from app.core.simulator import (
    REFC_HAZARD_DBZ,
    flight_position_at,
    sample_wx_at,
)

ARCHIVE_PATH = CACHE_DIR / "pirep_archive.json"
ARCHIVE_NP_PATH = CACHE_DIR / "pirep_archive.npz"


def _signature(refc: float, retop: float | None, alt_ft: float) -> tuple[float, float, float]:
    """Compact signature for similarity. Normalize each axis to roughly 0..1."""
    s_refc = float(refc) / 60.0
    s_margin = float(retop - alt_ft) / 20000.0 if retop is not None else 0.0
    s_alt = float(alt_ft) / 45000.0
    return s_refc, s_margin, s_alt


def build_archive(step_min: int = 15, save: bool = True) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    sigs: list[tuple[float, float, float]] = []
    for sid in list_scenarios():
        routes = load_routes(sid)
        for fl in routes["flights"]:
            t0 = fl["take_off_time_dt"]
            t1 = fl["scheduled_landing_time_dt"]
            total = (t1 - t0).total_seconds() / 60.0
            if total <= 0:
                continue
            n = max(2, int(total / step_min))
            alt = float(fl["cruise_altitude_ft"])
            for i in range(1, n):
                t = t0 + (t1 - t0) * (i / n)
                pos = flight_position_at(fl, t)
                if pos is None:
                    continue
                lat, lon, phase = pos
                if phase != "cruise":
                    continue
                refc = sample_wx_at(sid, "refc", lat, lon, t)
                if refc is None or refc < REFC_HAZARD_DBZ:
                    continue
                retop = sample_wx_at(sid, "retop", lat, lon, t)
                if retop is not None and retop <= alt:
                    continue
                sig = _signature(refc, retop, alt)
                records.append({
                    "scenario": sid,
                    "flight": fl["flight_number"],
                    "origin": fl["origin_airport_icao"],
                    "destination": fl["destination_airport_icao"],
                    "time": t.isoformat(),
                    "lat": round(lat, 3),
                    "lon": round(lon, 3),
                    "alt_ft": alt,
                    "refc_dbz": round(float(refc), 1),
                    "retop_ft": round(float(retop), 0) if retop is not None else None,
                    "filed_through_hazard": True,
                })
                sigs.append(sig)
    out = {"count": len(records), "records": records}
    if save:
        ARCHIVE_PATH.write_text(json.dumps(out))
        np.savez(ARCHIVE_NP_PATH, sigs=np.asarray(sigs))
    return out


def load_archive() -> tuple[list[dict[str, Any]], np.ndarray]:
    if not ARCHIVE_PATH.exists():
        out = build_archive()
        records = out["records"]
        sigs = np.load(ARCHIVE_NP_PATH)["sigs"]
        return records, sigs
    data = json.loads(ARCHIVE_PATH.read_text())
    sigs = np.load(ARCHIVE_NP_PATH)["sigs"]
    return data["records"], sigs


def find_analogs(refc: float, retop: float | None, alt_ft: float, k: int = 24) -> list[dict[str, Any]]:
    records, sigs = load_archive()
    if len(records) == 0:
        return []
    target = np.asarray(_signature(refc, retop, alt_ft))
    d = np.linalg.norm(sigs - target, axis=1)
    idx = np.argsort(d)[:k]
    out = []
    for i in idx:
        rec = dict(records[int(i)])
        rec["similarity"] = round(float(1.0 / (1.0 + d[int(i)])), 3)
        out.append(rec)
    return out


def analog_summary(analogs: list[dict[str, Any]]) -> dict[str, Any]:
    if not analogs:
        return {"count": 0, "median_refc": None, "scenarios": 0}
    refcs = [a["refc_dbz"] for a in analogs]
    scenarios = sorted({a["scenario"] for a in analogs})
    return {
        "count": len(analogs),
        "median_refc": round(float(np.median(refcs)), 1),
        "p90_refc": round(float(np.percentile(refcs, 90)), 1),
        "scenarios": len(scenarios),
        "scenario_list": scenarios,
    }
