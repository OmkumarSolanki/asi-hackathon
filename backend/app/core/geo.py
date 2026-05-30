from __future__ import annotations

import math

import numpy as np

EARTH_R_NM = 3440.065  # nautical miles


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_NM * math.asin(math.sqrt(a))


def haversine_vec(lats1: np.ndarray, lons1: np.ndarray, lats2: np.ndarray, lons2: np.ndarray) -> np.ndarray:
    p1, p2 = np.radians(lats1), np.radians(lats2)
    dp = np.radians(lats2 - lats1)
    dl = np.radians(lons2 - lons1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R_NM * np.arcsin(np.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def great_circle_points(lat1: float, lon1: float, lat2: float, lon2: float, n: int = 32) -> tuple[np.ndarray, np.ndarray]:
    """Return n equally spaced points along the great circle from 1 to 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    l1, l2 = math.radians(lon1), math.radians(lon2)
    d = 2 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2))
    if d == 0:
        return np.full(n, lat1), np.full(n, lon1)
    fs = np.linspace(0.0, 1.0, n)
    A = np.sin((1 - fs) * d) / math.sin(d)
    B = np.sin(fs * d) / math.sin(d)
    x = A * math.cos(p1) * math.cos(l1) + B * math.cos(p2) * math.cos(l2)
    y = A * math.cos(p1) * math.sin(l1) + B * math.cos(p2) * math.sin(l2)
    z = A * math.sin(p1) + B * math.sin(p2)
    lats = np.degrees(np.arctan2(z, np.sqrt(x * x + y * y)))
    lons = np.degrees(np.arctan2(y, x))
    return lats, lons


def cumulative_distances_nm(lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    if len(lats) < 2:
        return np.zeros_like(lats)
    seg = haversine_vec(lats[:-1], lons[:-1], lats[1:], lons[1:])
    return np.concatenate([[0.0], np.cumsum(seg)])


def interp_along_polyline(lats: np.ndarray, lons: np.ndarray, fraction: float) -> tuple[float, float]:
    """Position along polyline at given fraction in [0, 1] of total length."""
    fraction = max(0.0, min(1.0, fraction))
    cum = cumulative_distances_nm(lats, lons)
    total = cum[-1]
    if total == 0:
        return float(lats[0]), float(lons[0])
    target = fraction * total
    # Find segment
    idx = int(np.searchsorted(cum, target, side="right")) - 1
    idx = max(0, min(len(lats) - 2, idx))
    seg_frac = (target - cum[idx]) / max(cum[idx + 1] - cum[idx], 1e-9)
    lat = lats[idx] + seg_frac * (lats[idx + 1] - lats[idx])
    lon = lons[idx] + seg_frac * (lons[idx + 1] - lons[idx])
    return float(lat), float(lon)
