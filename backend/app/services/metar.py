from __future__ import annotations

"""Historical METAR fetcher via Iowa State Mesonet ASOS API.

Returns a single METAR closest to the requested time for the given ICAO airport.
"""

from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any

import requests


BASE_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"


@lru_cache(maxsize=2048)
def fetch_metar(icao: str, when: str) -> dict[str, Any] | None:
    """Fetch METAR within a 2-hour window around `when` (ISO 8601 UTC). Returns dict or None."""
    try:
        t = datetime.fromisoformat(when.replace("Z", "+00:00"))
    except Exception:
        return None
    icao4 = icao.upper()
    station = icao4[1:] if icao4.startswith("K") else icao4  # ASOS uses 3-letter for KXXX
    t0 = t - timedelta(hours=1)
    t1 = t + timedelta(hours=1)
    params = {
        "station": station,
        "data": "tmpf,dwpf,sknt,drct,vsby,gust,skyc1,skyl1,wxcodes,metar",
        "year1": t0.year, "month1": t0.month, "day1": t0.day,
        "hour1": t0.hour, "minute1": t0.minute,
        "year2": t1.year, "month2": t1.month, "day2": t1.day,
        "hour2": t1.hour, "minute2": t1.minute,
        "tz": "Etc/UTC",
        "format": "onlycomma",
        "missing": "M",
    }
    try:
        r = requests.get(BASE_URL, params=params, timeout=8)
        r.raise_for_status()
    except Exception:
        return None
    lines = r.text.strip().splitlines()
    if len(lines) < 2:
        return None
    header = [h.strip() for h in lines[0].split(",")]
    rows = []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) != len(header):
            continue
        rows.append(dict(zip(header, parts)))
    if not rows:
        return None
    # closest to t
    def parse_dt(s: str) -> datetime:
        return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=t.tzinfo)
    rows.sort(key=lambda r: abs((parse_dt(r["valid"]) - t).total_seconds()))
    best = rows[0]
    def f(k: str) -> float | None:
        v = best.get(k)
        if v in (None, "", "M"):
            return None
        try:
            return float(v)
        except Exception:
            return None
    sknt = f("sknt"); drct = f("drct"); gust = f("gust"); vsby = f("vsby")
    return {
        "station": station,
        "icao": icao4,
        "valid_utc": best.get("valid"),
        "wind_kt": sknt,
        "wind_dir_deg": drct,
        "gust_kt": gust,
        "visibility_mi": vsby,
        "ceiling_ft": f("skyl1"),
        "metar_raw": best.get("metar"),
        "temp_f": f("tmpf"),
        "dewpoint_f": f("dwpf"),
        "wx_codes": best.get("wxcodes"),
    }


def landing_assessment(icao: str, when: str, runway_heading_deg: float | None = None) -> dict[str, Any]:
    m = fetch_metar(icao, when)
    if m is None:
        return {"available": False, "icao": icao, "note": "No METAR available for this time/airport."}
    crosswind = None
    if runway_heading_deg is not None and m.get("wind_dir_deg") is not None and m.get("wind_kt") is not None:
        import math
        delta = abs((m["wind_dir_deg"] - runway_heading_deg + 180) % 360 - 180)
        crosswind = abs(m["wind_kt"] * math.sin(math.radians(delta)))
    warnings: list[str] = []
    if m.get("wind_kt") and m["wind_kt"] >= 30:
        warnings.append(f"High surface wind {int(m['wind_kt'])} kt")
    if m.get("gust_kt") and m["gust_kt"] >= 35:
        warnings.append(f"Gusts {int(m['gust_kt'])} kt")
    if m.get("visibility_mi") is not None and m["visibility_mi"] < 1.0:
        warnings.append(f"Low visibility {m['visibility_mi']} mi")
    return {
        "available": True,
        "icao": m["icao"],
        "valid_utc": m["valid_utc"],
        "wind_kt": m["wind_kt"],
        "wind_dir_deg": m["wind_dir_deg"],
        "gust_kt": m["gust_kt"],
        "visibility_mi": m["visibility_mi"],
        "crosswind_kt": round(crosswind, 1) if crosswind is not None else None,
        "metar_raw": m.get("metar_raw"),
        "warnings": warnings,
        "summary": (
            "Winds suitable for landing."
            if not warnings
            else "Landing conditions degraded: " + "; ".join(warnings)
        ),
    }
