from __future__ import annotations

"""Surface wind snapshot — pulls METAR for ~30 major US airports at the scenario time.

We don't have grid wind data in the bundle, so this approximates by sampling METARs
at the busiest airports across CONUS. Good enough to show 'where the wind is moving'
without inventing a wind field.
"""

import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

from app.services.metar import fetch_metar

# Top US airports by traffic, distributed across CONUS for good map coverage
MAJOR_AIRPORTS: list[tuple[str, float, float]] = [
    ("KATL", 33.6407, -84.4277), ("KORD", 41.9742, -87.9073), ("KDFW", 32.8998, -97.0403),
    ("KDEN", 39.8617, -104.6732), ("KLAX", 33.9416, -118.4085), ("KJFK", 40.6413, -73.7781),
    ("KSFO", 37.6188, -122.3754), ("KSEA", 47.4502, -122.3088), ("KLAS", 36.0840, -115.1537),
    ("KMCO", 28.4312, -81.3081), ("KEWR", 40.6895, -74.1745), ("KCLT", 35.2144, -80.9473),
    ("KPHX", 33.4373, -112.0078), ("KIAH", 29.9902, -95.3368), ("KMIA", 25.7959, -80.2870),
    ("KBOS", 42.3656, -71.0096), ("KMSP", 44.8848, -93.2223), ("KFLL", 26.0726, -80.1527),
    ("KDTW", 42.2125, -83.3534), ("KPHL", 39.8729, -75.2437), ("KLGA", 40.7769, -73.8740),
    ("KBWI", 39.1774, -76.6684), ("KSLC", 40.7884, -111.9778), ("KDCA", 38.8521, -77.0377),
    ("KIAD", 38.9445, -77.4558), ("KSAN", 32.7338, -117.1933), ("KTPA", 27.9755, -82.5332),
    ("KHOU", 29.6454, -95.2789), ("KPDX", 45.5887, -122.5975), ("KSTL", 38.7487, -90.3700),
    ("KBNA", 36.1245, -86.6782), ("KAUS", 30.1975, -97.6664), ("KMSY", 29.9934, -90.2580),
    ("KRDU", 35.8776, -78.7875), ("KSJC", 37.3639, -121.9289), ("KCLE", 41.4117, -81.8498),
]


def _synthetic_wind(lat: float, lon: float, hours: float | None = None) -> tuple[float, float]:
    """Climatological fallback when METAR data is missing.

    Prevailing US flow is westerly (jet stream); strength varies modestly with latitude
    and is stronger over the upper Midwest. Direction wind COMES FROM, in degrees.

    When ``hours`` (absolute hours since the epoch) is given, a slow,
    location-phased diurnal modulation is added so the field visibly evolves as
    the user scrubs the timeline — the bundle has no real wind grid, so this is
    an explicitly synthetic approximation.
    """
    base_dir = 270.0  # westerly
    # Slight curvature: higher latitudes ~ 280°, lower ~ 250°
    dir_deg = base_dir + (lat - 38) * 1.4
    # Speed: 10 kt baseline + latitude bump + small east-west variation
    speed = 12.0 + max(0.0, (lat - 30) * 0.5) + max(0.0, (-95 - lon) * 0.05)
    if hours is not None:
        ph = (lon + lat) * 0.05               # phase varies by location
        dir_deg += 25.0 * math.sin(hours / 3.0 + ph)        # veers over a few hours
        speed += 8.0 * math.sin(hours / 2.0 + ph * 1.7)     # pulses over a few hours
    speed = max(4.0, min(48.0, speed))
    return dir_deg % 360.0, round(speed, 1)


def _coarse_metar_when(when: str) -> str:
    """Round the time to a 30-min bucket for the METAR fetch so continuous
    scrubbing reuses the cache (and the network) instead of hammering it."""
    try:
        dt = datetime.fromisoformat(when.replace("Z", "+00:00"))
    except Exception:
        return when
    return dt.replace(minute=(dt.minute // 30) * 30, second=0, microsecond=0).isoformat()


def fetch_winds(when: str) -> dict[str, Any]:
    """Fetch wind for ~30 major airports.

    Tries METAR first. If METAR data is missing for a station, falls back to a
    time-varying synthetic wind (clearly labeled) so the map always has data and
    evolves as you scrub — METAR archive coverage is patchy for some past dates.
    """
    metar_when = _coarse_metar_when(when)
    try:
        hours = datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() / 3600.0
    except Exception:
        hours = None

    def _one(item: tuple[str, float, float]) -> dict[str, Any]:
        icao, lat, lon = item
        m = fetch_metar(icao, metar_when)
        if m is not None and m.get("wind_kt") is not None and m.get("wind_dir_deg") is not None:
            return {
                "icao": icao,
                "lat": lat,
                "lon": lon,
                "wind_kt": float(m["wind_kt"]),
                "wind_dir_deg": float(m["wind_dir_deg"]),
                "gust_kt": m.get("gust_kt"),
                "source": "metar",
            }
        # Fallback: time-varying synthetic climatological wind
        d, s = _synthetic_wind(lat, lon, hours)
        return {
            "icao": icao,
            "lat": lat,
            "lon": lon,
            "wind_kt": s,
            "wind_dir_deg": d,
            "gust_kt": None,
            "source": "synthetic",
        }

    out: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        for r in ex.map(_one, MAJOR_AIRPORTS):
            out.append(r)
    metar_count = sum(1 for r in out if r["source"] == "metar")
    return {"time": when, "count": len(out), "metar_count": metar_count, "stations": out}
