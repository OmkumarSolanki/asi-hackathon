#!/usr/bin/env python3
"""Render a US map with the planned waypoint route of a given flight.

Reads route snapshots from the hackathon data bundle (see
``hackathon_data_bundle/documentation/routes/FILE_FORMAT.md``) and draws the
flight's planned path over a continental-US basemap with matplotlib + cartopy.

Given a "current" time (``--time``) it also:
  * positions an airplane icon along the route,
  * overlays the composite-reflectivity weather valid at that time
    (see ``documentation/wx/FILE_FORMAT.md``), and
  * proposes A* reroutes *from the current position* around hazardous storms
    forecast in the next LOOKAHEAD_MIN minutes, and around over-demand ATC
    sectors (see ``documentation/sectors/FILE_FORMAT.md``), colored by a goodness
    score (see SCORE_FACTORS) trading off distance, weather, and sector load.
    Options that would enter a saturated sector are drawn red ("not taken").

Usage:
    python3 dont_crash.py -f SWA3209 -d 2025-07-08 -t 2025-07-08T22:00
"""

from __future__ import annotations

import argparse
import glob
import gzip
import heapq
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Callable

import numpy as np


# Continental-US extent: [west_lon, east_lon, south_lat, north_lat].
CONUS_EXTENT = [-125.0, -66.0, 23.0, 50.0]

# Weather grid geometry (see documentation/wx/FILE_FORMAT.md).
# imshow extent is [lon_min, lon_max, lat_min, lat_max].
WX_ROWS, WX_COLS = 256, 358
WX_LAT_MIN, WX_LAT_MAX = 21.943, 55.7765
WX_LON_MIN, WX_LON_MAX = -135.0, -67.5
WX_EXTENT = [WX_LON_MIN, WX_LON_MAX, WX_LAT_MIN, WX_LAT_MAX]
# Cells below this dBZ (clear air) and the nodata sentinel (<= -50) are both
# rendered transparent so only actual precipitation is drawn.
WX_MIN_DBZ = 5.0
# At/above this composite reflectivity, precipitation is considered hazardous
# to fly through (see documentation/wx/FILE_FORMAT.md).
HAZARD_DBZ = 40.0

# Earth radius in nautical miles.
EARTH_RADIUS_NM = 3440.065

# Logo drawn in the corner of the output (sits next to this script).
LOGO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo.jpg")

# Alternative-route generation. Each candidate is an A* path that avoids storms
# (cost = distance + REROUTE_WEIGHT * cell severity); candidates are diversified
# into a fan by routing through waypoints offset laterally (deg) from the direct
# course midpoint, so we always show several distinct options to compare.
REROUTE_WEIGHT = 6.0
REROUTE_OFFSETS_DEG = [0.0, 3.0, -3.0, 6.0]
# Coarsen the weather grid by this factor for pathfinding (speed vs detail).
PATHFIND_STRIDE = 2
# Reroutes avoid hazards forecast anywhere from now to now + this many minutes,
# so the aircraft steers clear of storms it is about to reach.
LOOKAHEAD_MIN = 30

# A* cost (in dBZ-equivalent units, like weather severity) charged per grid cell
# that lies inside an over-demand sector, so the sector-aware reroute treats a
# saturated sector roughly like a severe storm and routes around it.
SECTOR_OVERLOAD_COST = 80.0
# Altitude band boundary between LOW [0, 35000) and HIGH [35000, 60000) sectors.
SECTOR_BAND_SPLIT_FT = 35000


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def available_dates(bundle):
    """Return the sorted list of snapshot dates (YYYY-MM-DD) found in the bundle."""
    dates = []
    for path in glob.glob(os.path.join(bundle, "asked_at_*T*Z")):
        name = os.path.basename(path)
        # name looks like: asked_at_2026-03-04T18:00:00Z
        stamp = name[len("asked_at_"):]
        dates.append(stamp.split("T", 1)[0])
    return sorted(set(dates))


def find_snapshot_dir(bundle, date):
    """Return the snapshot directory whose asked_at calendar date == ``date``."""
    matches = sorted(glob.glob(os.path.join(bundle, f"asked_at_{date}T*Z")))
    return matches[0] if matches else None


def load_routes(snapshot_dir):
    """Load the routes payload from a snapshot dir (plain or gzipped JSON)."""
    plain = os.path.join(snapshot_dir, "routes.json")
    gzipped = os.path.join(snapshot_dir, "routes.json.gz")
    if os.path.exists(plain):
        with open(plain, "r") as fh:
            return json.load(fh)
    if os.path.exists(gzipped):
        with gzip.open(gzipped, "rt") as fh:
            return json.load(fh)
    raise FileNotFoundError(
        f"no routes.json or routes.json.gz in {snapshot_dir}"
    )


def find_flights(flights, flight_number):
    """Return all flight records matching the flight number (case-insensitive)."""
    target = flight_number.upper()
    return [f for f in flights if str(f.get("flight_number", "")).upper() == target]


def _parse_wx_stamp(stamp):
    """Parse a 'YYYY-MM-DD_HH:MM:SS' weather timestamp into an aware datetime."""
    return datetime.strptime(stamp, "%Y-%m-%d_%H:%M:%S").replace(tzinfo=timezone.utc)


def parse_wx_filename(path):
    """Extract (valid_from, valid_to) datetimes from a wx .npz filename.

    Filenames are ``{based_at}_{valid_from}_{valid_to}.npz`` where each stamp is
    ``YYYY-MM-DD_HH:MM:SS`` (so each contributes two underscore-separated parts).
    """
    name = os.path.basename(path)[: -len(".npz")]
    parts = name.split("_")
    if len(parts) != 6:
        return None
    valid_from = _parse_wx_stamp(parts[2] + "_" + parts[3])
    valid_to = _parse_wx_stamp(parts[4] + "_" + parts[5])
    return valid_from, valid_to


def select_wx_strip(snapshot_dir, target_time, kind="refc"):
    """Pick the wx .npz strip valid at ``target_time`` (nearest valid_from else).

    Returns ``(path, valid_from, valid_to)`` or ``None`` if no strips exist.
    """
    wx_dir = os.path.join(snapshot_dir, "wx", kind)
    strips = []
    for path in glob.glob(os.path.join(wx_dir, "*.npz")):
        parsed = parse_wx_filename(path)
        if parsed is not None:
            strips.append((path, parsed[0], parsed[1]))
    if not strips:
        return None
    # Prefer a strip whose [valid_from, valid_to) window contains target_time.
    for path, vf, vt in strips:
        if vf <= target_time < vt:
            return path, vf, vt
    # Otherwise the strip with the closest valid_from.
    return min(strips, key=lambda s: abs((s[1] - target_time).total_seconds()))


def describe_leg(flight):
    return (
        f"{flight.get('flight_number')}  "
        f"{flight.get('origin_airport_icao')}→{flight.get('destination_airport_icao')}  "
        f"dep {flight.get('take_off_time')}"
    )


# --------------------------------------------------------------------------
# Route scoring
#
# A route's "goodness" is a weighted blend of cost factors. To add a new
# consideration later (e.g. fuel burn, time en route, airspace congestion),
# add a field to RouteMetrics, populate it where routes are built, and append a
# ScoreFactor below — nothing else needs to change.
# --------------------------------------------------------------------------
@dataclass
class RouteMetrics:
    distance_nm: float        # total great-circle length of the route
    weather_severity: float   # dBZ·nm of hazardous precip flown through
    sector_overload_nm: float = 0.0  # nm flown through over-demand sectors


@dataclass
class ScoreFactor:
    name: str
    weight: float                       # relative importance (higher = matters more)
    extract: Callable[[RouteMetrics], float]  # -> raw cost (higher = worse)


# The knobs to tune as the model evolves.
SCORE_FACTORS = [
    ScoreFactor("distance", 1.0, lambda m: m.distance_nm),
    ScoreFactor("weather", 2.0, lambda m: m.weather_severity),
    ScoreFactor("sectors", 3.0, lambda m: m.sector_overload_nm),
]


def score_routes(metrics, factors=SCORE_FACTORS):
    """Return (costs, goodness) arrays for a list of RouteMetrics.

    Each factor is min-max normalized across the candidate set so factors with
    different units (nm vs dBZ·nm) combine sensibly, then weighted and summed
    into a cost. ``goodness`` is the cost rescaled to [0, 1] with 1 = best.
    """
    n = len(metrics)
    costs = np.zeros(n)
    for f in factors:
        raw = np.array([f.extract(m) for m in metrics], dtype=float)
        span = raw.max() - raw.min()
        norm = (raw - raw.min()) / span if span > 1e-9 else np.zeros(n)
        costs += f.weight * norm
    cspan = costs.max() - costs.min()
    goodness = 1.0 - (costs - costs.min()) / cspan if cspan > 1e-9 else np.ones(n)
    return costs, goodness


# --------------------------------------------------------------------------
# Geographic helpers
# --------------------------------------------------------------------------
def haversine_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(a))


def polyline_length_nm(lats, lons):
    return sum(
        haversine_nm(lats[i], lons[i], lats[i + 1], lons[i + 1])
        for i in range(len(lats) - 1)
    )


def view_extent(coord_seqs, pad_frac=0.12, min_lon=5.0, min_lat=3.5):
    """Bounding [lon_min, lon_max, lat_min, lat_max] covering all (lats, lons)
    sequences, padded and clamped to a minimum span so short flights still get
    some surrounding context."""
    xs, ys = [], []
    for la, lo in coord_seqs:
        ys.extend(la)
        xs.extend(lo)
    w, e, s, n = min(xs), max(xs), min(ys), max(ys)
    if e - w < min_lon:
        c = (w + e) / 2
        w, e = c - min_lon / 2, c + min_lon / 2
    if n - s < min_lat:
        c = (s + n) / 2
        s, n = c - min_lat / 2, c + min_lat / 2
    px, py = pad_frac * (e - w), pad_frac * (n - s)
    return [w - px, e + px, s - py, n + py]


def fit_extent_to_aspect(extent, target_aspect):
    """Grow an extent (never shrink) so its lon:lat span matches target_aspect.

    Lets a fixed-size, equal-aspect map axes be filled without letterboxing or
    distortion — the view just shows a little extra area on the short axis."""
    w, e, s, n = extent
    dlon, dlat = e - w, n - s
    if dlon / dlat < target_aspect:
        new = dlat * target_aspect
        c = (w + e) / 2
        w, e = c - new / 2, c + new / 2
    else:
        new = dlon / target_aspect
        c = (s + n) / 2
        s, n = c - new / 2, c + new / 2
    return [w, e, s, n]


def split_at_fraction(lats, lons, frac):
    """Split a polyline at fractional distance ``frac`` along it.

    Returns ``(plat, plon, heading, flown, remaining)`` where ``flown`` and
    ``remaining`` are each ``(lats, lons)`` of the path before and after the
    split point, both including the split point itself. Heading is degrees CCW
    from east (matching PlateCarree display axes), so an icon rotated by it
    aligns with the drawn line."""
    frac = max(0.0, min(1.0, frac))
    cum = [0.0]
    for i in range(len(lats) - 1):
        cum.append(cum[-1] + haversine_nm(lats[i], lons[i], lats[i + 1], lons[i + 1]))
    total = cum[-1]
    if total <= 0:
        return lats[0], lons[0], 0.0, ([lats[0]], [lons[0]]), (list(lats), list(lons))
    target = frac * total
    seg = max(0, min(len(lats) - 2, int(np.searchsorted(cum, target) - 1)))
    seg_len = cum[seg + 1] - cum[seg]
    t = (target - cum[seg]) / seg_len if seg_len > 0 else 0.0
    plat = lats[seg] + t * (lats[seg + 1] - lats[seg])
    plon = lons[seg] + t * (lons[seg + 1] - lons[seg])
    heading = math.degrees(math.atan2(
        lats[seg + 1] - lats[seg], lons[seg + 1] - lons[seg]
    ))
    flown = (list(lats[:seg + 1]) + [plat], list(lons[:seg + 1]) + [plon])
    remaining = ([plat] + list(lats[seg + 1:]), [plon] + list(lons[seg + 1:]))
    return plat, plon, heading, flown, remaining


# --------------------------------------------------------------------------
# Weather severity grid and A* rerouting
# --------------------------------------------------------------------------
def load_wx_matrix(snapshot_dir, target_time, kind):
    """Return (matrix, valid_from, valid_to) for the strip valid at target_time,
    or None if no strips exist for this kind."""
    strip = select_wx_strip(snapshot_dir, target_time, kind=kind)
    if strip is None:
        return None
    path, valid_from, valid_to = strip
    return np.load(path)["matrix"], valid_from, valid_to


def hazard_severity_grid(refc, retop, cruise_altitude_ft):
    """Per-cell hazard severity (dBZ): refc where precip is both intense
    (>= HAZARD_DBZ) and tall enough to reach the flight's altitude, else 0."""
    hazardous = refc >= HAZARD_DBZ
    if retop is not None and cruise_altitude_ft:
        hazardous &= retop >= cruise_altitude_ft
    return np.where(hazardous, np.clip(refc, 0.0, None), 0.0)


def lookahead_severity_grid(snapshot_dir, current_time, cruise_altitude_ft,
                            minutes=LOOKAHEAD_MIN):
    """Worst-case hazard severity over the forecast window [now, now+minutes].

    Rerouting against this (rather than a single instant) lets the aircraft
    avoid storms it will reach within the next several minutes, not just the
    weather underneath it right now. Returns None if no strips are available."""
    window_end = current_time + timedelta(minutes=minutes)
    refc_dir = os.path.join(snapshot_dir, "wx", "refc")
    retop_dir = os.path.join(snapshot_dir, "wx", "retop")
    combined = None
    for path in sorted(glob.glob(os.path.join(refc_dir, "*.npz"))):
        parsed = parse_wx_filename(path)
        if parsed is None:
            continue
        valid_from, valid_to = parsed
        # Strip overlaps the lookahead window.
        if valid_to <= current_time or valid_from >= window_end:
            continue
        refc = np.load(path)["matrix"]
        retop_path = os.path.join(retop_dir, os.path.basename(path))
        retop = np.load(retop_path)["matrix"] if os.path.exists(retop_path) else None
        sev = hazard_severity_grid(refc, retop, cruise_altitude_ft)
        combined = sev if combined is None else np.maximum(combined, sev)
    return combined


def latlon_to_ij(lat, lon):
    """Nearest full-resolution grid cell (row, col) for a lat/lon."""
    i = int(round((WX_LAT_MAX - lat) / (WX_LAT_MAX - WX_LAT_MIN) * WX_ROWS - 0.5))
    j = int(round((lon - WX_LON_MIN) / (WX_LON_MAX - WX_LON_MIN) * WX_COLS - 0.5))
    return min(max(i, 0), WX_ROWS - 1), min(max(j, 0), WX_COLS - 1)


def severity_along(lats, lons, severity, step_nm=8.0):
    """Integrate hazard severity (dBZ·nm) sampled along a polyline."""
    total = 0.0
    for i in range(len(lats) - 1):
        seg_nm = haversine_nm(lats[i], lons[i], lats[i + 1], lons[i + 1])
        steps = max(1, int(seg_nm / step_nm))
        for s in range(steps):
            t = (s + 0.5) / steps
            lat = lats[i] + t * (lats[i + 1] - lats[i])
            lon = lons[i] + t * (lons[i + 1] - lons[i])
            gi, gj = latlon_to_ij(lat, lon)
            total += severity[gi, gj] * (seg_nm / steps)
    return total


def _maxpool(grid, k):
    """Max-pool a 2D grid by factor k (so storms are never coarsened away)."""
    if k == 1:
        return grid
    rows, cols = grid.shape
    pr, pc = (-rows) % k, (-cols) % k
    padded = np.pad(grid, ((0, pr), (0, pc)), constant_values=0.0)
    h, w = padded.shape
    return padded.reshape(h // k, k, w // k, k).max(axis=(1, 3))


def _simplify(lats, lons, tol_deg=0.02):
    """Drop points that are nearly collinear with their neighbours."""
    if len(lats) <= 2:
        return lats, lons
    out_lat, out_lon = [lats[0]], [lons[0]]
    for i in range(1, len(lats) - 1):
        ax, ay = lons[i] - out_lon[-1], lats[i] - out_lat[-1]
        bx, by = lons[i + 1] - lons[i], lats[i + 1] - lats[i]
        cross = ax * by - ay * bx
        if abs(cross) > tol_deg * tol_deg:
            out_lat.append(lats[i])
            out_lon.append(lons[i])
    out_lat.append(lats[-1])
    out_lon.append(lons[-1])
    return out_lat, out_lon


def astar_route(severity, origin_ll, dest_ll, weight, stride=PATHFIND_STRIDE):
    """A* from origin to destination over the (downsampled) weather grid.

    Step cost = great-circle distance + ``weight`` * cell severity, so larger
    weights bend the path around hazardous cells. Returns a simplified list of
    (lats, lons) with the true origin/destination pinned to the ends, or None.
    """
    sev = _maxpool(severity, stride)
    rows, cols = sev.shape
    lat_c = (WX_LAT_MAX
             - (np.arange(rows) * stride + (stride - 1) / 2 + 0.5)
             / WX_ROWS * (WX_LAT_MAX - WX_LAT_MIN))
    lon_c = (WX_LON_MIN
             + (np.arange(cols) * stride + (stride - 1) / 2 + 0.5)
             / WX_COLS * (WX_LON_MAX - WX_LON_MIN))

    def nearest(lat, lon):
        return (int(np.argmin(np.abs(lat_c - lat))),
                int(np.argmin(np.abs(lon_c - lon))))

    start = nearest(*origin_ll)
    goal = nearest(*dest_ll)
    glat, glon = lat_c[goal[0]], lon_c[goal[1]]

    def h(i, j):
        return haversine_nm(lat_c[i], lon_c[j], glat, glon)

    g = np.full((rows, cols), np.inf)
    g[start] = 0.0
    came = {}
    pq = [(h(*start), start)]
    neighbours = [(-1, 0), (1, 0), (0, -1), (0, 1),
                  (-1, -1), (-1, 1), (1, -1), (1, 1)]
    while pq:
        _, (i, j) = heapq.heappop(pq)
        if (i, j) == goal:
            break
        base = g[i, j]
        for di, dj in neighbours:
            ni, nj = i + di, j + dj
            if not (0 <= ni < rows and 0 <= nj < cols):
                continue
            step = haversine_nm(lat_c[i], lon_c[j], lat_c[ni], lon_c[nj])
            tentative = base + step + weight * sev[ni, nj]
            if tentative < g[ni, nj]:
                g[ni, nj] = tentative
                came[(ni, nj)] = (i, j)
                heapq.heappush(pq, (tentative + h(ni, nj), (ni, nj)))

    if (goal not in came) and goal != start:
        return None
    path = [goal]
    while path[-1] != start:
        path.append(came[path[-1]])
    path.reverse()
    lats = [lat_c[i] for i, _ in path]
    lons = [lon_c[j] for _, j in path]
    # Pin true airport coordinates at the ends.
    lats[0], lons[0] = origin_ll
    lats[-1], lons[-1] = dest_ll
    return _simplify(lats, lons)


# --------------------------------------------------------------------------
# Sectors and over-demand (capacity) handling
#
# Each ATC sector has a capacity (max flights it should hold at once). We count
# how many flights occupy each sector at the current time; sectors over capacity
# are "over-demand" and are treated as obstacles for rerouting, just like storms.
# --------------------------------------------------------------------------
def flight_band(cruise_altitude_ft):
    return "HIGH" if (cruise_altitude_ft or 0) >= SECTOR_BAND_SPLIT_FT else "LOW"


def load_sectors(bundle):
    """Load sectors.geojson into per-band geometries, capacities and a spatial
    index. Returns None if the file is absent."""
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    path = os.path.join(bundle, "sectors.geojson")
    gz = path + ".gz"
    if os.path.exists(path):
        with open(path) as fh:
            data = json.load(fh)
    elif os.path.exists(gz):
        with gzip.open(gz, "rt") as fh:
            data = json.load(fh)
    else:
        return None

    bands = {"HIGH": {"geoms": [], "names": [], "caps": []},
             "LOW": {"geoms": [], "names": [], "caps": []}}
    for f in data["features"]:
        p = f["properties"]
        band = "HIGH" if p["name"].startswith("HIGH") else "LOW"
        bands[band]["geoms"].append(shape(f["geometry"]))
        bands[band]["names"].append(p["name"])
        bands[band]["caps"].append(p["capacity"])
    for band in bands.values():
        band["tree"] = STRtree(band["geoms"])
    return bands


def compute_sector_loads(flights, current_time, sectors):
    """Count airborne flights occupying each sector at current_time, keyed by
    band -> {sector_name: load}."""
    from shapely.geometry import Point

    loads = {"HIGH": {}, "LOW": {}}
    for fl in flights:
        la, lo = fl.get("lats"), fl.get("lons")
        if not la or not lo or len(la) < 2:
            continue
        frac = flight_fraction(fl, current_time)
        if frac <= 0 or frac >= 1:
            continue  # only count flights currently in the air
        plat, plon, *_ = split_at_fraction(la, lo, frac)
        band_key = flight_band(fl.get("cruise_altitude_ft"))
        band = sectors[band_key]
        pt = Point(plon, plat)
        for i in band["tree"].query(pt):
            if band["geoms"][i].contains(pt):
                nm = band["names"][i]
                loads[band_key][nm] = loads[band_key].get(nm, 0) + 1
                break
    return loads


def overloaded_in_band(sectors, loads, band):
    """List of over-demand sectors in a band: dicts with name/load/cap/geom."""
    b = sectors[band]
    out = []
    for i, nm in enumerate(b["names"]):
        load = loads[band].get(nm, 0)
        if load > b["caps"][i]:
            out.append({"name": nm, "load": load, "cap": b["caps"][i],
                        "geom": b["geoms"][i]})
    return out


def overload_mask_grid(over_sectors):
    """Boolean weather-grid mask of cells whose center lies in an over-demand
    sector (used to penalise those cells during A*)."""
    from matplotlib.path import Path

    lat_c = WX_LAT_MAX - (np.arange(WX_ROWS) + 0.5) / WX_ROWS * (WX_LAT_MAX - WX_LAT_MIN)
    lon_c = WX_LON_MIN + (np.arange(WX_COLS) + 0.5) / WX_COLS * (WX_LON_MAX - WX_LON_MIN)
    lon_g, lat_g = np.meshgrid(lon_c, lat_c)
    pts = np.column_stack([lon_g.ravel(), lat_g.ravel()])
    mask = np.zeros(pts.shape[0], dtype=bool)
    for s in over_sectors:
        coords = np.asarray(s["geom"].exterior.coords)
        mask |= Path(coords).contains_points(pts)
    return mask.reshape(WX_ROWS, WX_COLS)


def _route_signature(lats, lons):
    return tuple(round(v, 1) for v in lats) + tuple(round(v, 1) for v in lons)


def _perp_unit(origin_ll, dest_ll):
    """Unit vector (dlat, dlon) perpendicular to the origin->dest course."""
    dy = dest_ll[0] - origin_ll[0]
    dx = dest_ll[1] - origin_ll[1]
    norm = math.hypot(dx, dy) or 1.0
    return (-dx / norm, dy / norm)


def _astar_via(severity, origin_ll, via_ll, dest_ll):
    """A* origin->via->dest, concatenated (or None if either leg fails)."""
    leg_a = astar_route(severity, origin_ll, via_ll, REROUTE_WEIGHT)
    leg_b = astar_route(severity, via_ll, dest_ll, REROUTE_WEIGHT)
    if leg_a is None or leg_b is None:
        return None
    return leg_a[0] + leg_b[0][1:], leg_a[1] + leg_b[1][1:]


def build_routes(start_ll, dest_ll, baseline, severity, overload_mask=None):
    """Build candidate routes from the aircraft's current position to the
    destination.

    The first candidate ("on plan") is the remaining filed route ``baseline``
    (a ``(lats, lons)`` tuple from the current point onward). The rest are a fan
    of A* alternatives that steer around hazardous weather; when ``overload_mask``
    is given (over-demand sector cells), an extra "sector-aware" reroute avoids
    both storms and saturated sectors. Each route is a dict with
    name/lats/lons/metrics."""
    routes = [{
        "name": "on plan",
        "lats": list(baseline[0]),
        "lons": list(baseline[1]),
    }]
    if severity is not None:
        perp = _perp_unit(start_ll, dest_ll)
        mid = ((start_ll[0] + dest_ll[0]) / 2, (start_ll[1] + dest_ll[1]) / 2)
        seen = {_route_signature(routes[0]["lats"], routes[0]["lons"])}
        n = 0
        for offset in REROUTE_OFFSETS_DEG:
            if offset == 0.0:
                alt = astar_route(severity, start_ll, dest_ll, REROUTE_WEIGHT)
            else:
                via = (mid[0] + perp[0] * offset, mid[1] + perp[1] * offset)
                alt = _astar_via(severity, start_ll, via, dest_ll)
            if alt is None:
                continue
            sig = _route_signature(*alt)
            if sig in seen:
                continue
            seen.add(sig)
            n += 1
            name = "reroute (direct)" if offset == 0.0 else f"reroute {n}"
            routes.append({"name": name, "lats": alt[0], "lons": alt[1]})

        # Sector-aware reroute: also avoid over-demand sectors.
        if overload_mask is not None and overload_mask.any():
            combined = severity + overload_mask * SECTOR_OVERLOAD_COST
            alt = astar_route(combined, start_ll, dest_ll, REROUTE_WEIGHT)
            if alt is not None and _route_signature(*alt) not in seen:
                seen.add(_route_signature(*alt))
                routes.append({"name": "reroute (sector-aware)",
                               "lats": alt[0], "lons": alt[1]})

    mask_f = overload_mask.astype(float) if overload_mask is not None else None
    for r in routes:
        dist = polyline_length_nm(r["lats"], r["lons"])
        sev = severity_along(r["lats"], r["lons"], severity) if severity is not None else 0.0
        over = severity_along(r["lats"], r["lons"], mask_f) if mask_f is not None else 0.0
        r["metrics"] = RouteMetrics(distance_nm=dist, weather_severity=sev,
                                    sector_overload_nm=over)
    return routes


# The '✈' glyph (DejaVu) points east at rotation 0, matching our heading
# convention (degrees CCW from east), so no extra offset is needed. Adjust if a
# different font renders the plane glyph at another resting orientation.
PLANE_GLYPH_BASE_DEG = 0.0


def flight_fraction(flight, current_time):
    """Fraction [0, 1] of the flight elapsed at current_time (by time, which
    equals distance flown under the constant-speed model)."""
    take_off = flight.get("take_off_time")
    landing = flight.get("scheduled_landing_time")
    if not (take_off and landing and current_time):
        return 0.0
    t0 = datetime.fromisoformat(take_off)
    t1 = datetime.fromisoformat(landing)
    span = (t1 - t0).total_seconds()
    if span <= 0:
        return 0.0
    return max(0.0, min(1.0, (current_time - t0).total_seconds() / span))


def draw_logo(fig):
    """Draw the logo in the figure's upper-left margin (off the map) with
    'Don't Crash!' curved around the bottom of the circle."""
    if not os.path.exists(LOGO_PATH):
        eprint(f"warning: logo not found at {LOGO_PATH}; skipping.")
        return
    import matplotlib.image as mpimg

    logo = mpimg.imread(LOGO_PATH)
    # Small inset in the top-left corner; the wide CONUS map leaves this margin
    # empty, so the logo never overlaps the plotted area.
    lax = fig.add_axes([0.005, 0.855, 0.11, 0.12], zorder=20)
    lax.imshow(logo, extent=[-1, 1, -1, 1])
    lax.set_xlim(-1.35, 1.35)
    lax.set_ylim(-1.7, 1.15)  # extra room below for the curved caption
    lax.set_aspect("equal")
    lax.axis("off")

    text = "Don't Crash!"
    radius = 1.16              # just outside the circle's edge
    step_deg = 11.0            # angular spacing between characters
    centre_deg = 270.0         # bottom of the circle
    start = centre_deg - step_deg * (len(text) - 1) / 2
    for k, ch in enumerate(text):
        ang = start + step_deg * k          # increasing angle reads left->right
        rad = math.radians(ang)
        x, y = radius * math.cos(rad), radius * math.sin(rad)
        lax.text(x, y, ch, rotation=ang + 90, rotation_mode="anchor",
                 ha="center", va="center", fontsize=8.5, fontweight="bold",
                 color="#b30000", zorder=21)


def parse_current_time(arg, flight):
    """Parse the --time argument into an aware UTC datetime.

    Accepts a full ISO timestamp (optionally with 'Z'); a bare time of day
    (e.g. '20:30') is combined with the flight's takeoff date. Returns None if
    no argument was given. Raises ValueError on unparseable input."""
    if not arg:
        return None
    take_off = flight.get("take_off_time")
    base = datetime.fromisoformat(take_off) if take_off else datetime.now(timezone.utc)
    s = arg.strip().replace("Z", "+00:00")
    if "-" in s:  # contains a date component
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    tod = time.fromisoformat(s)  # bare time of day
    return base.replace(hour=tod.hour, minute=tod.minute,
                        second=tod.second, microsecond=0)


def plot_flight(flight, output, show, snapshot_dir=None, weather=True,
                current_time=None, all_flights=None, sectors=None,
                use_sectors=True):
    # Imported lazily so --help and error paths don't pay the import cost.
    import matplotlib

    if not show:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import cartopy.crs as ccrs
    import cartopy.feature as cfeature
    from matplotlib.lines import Line2D

    lats = flight.get("lats") or []
    lons = flight.get("lons") or []
    if len(lats) < 2 or len(lons) < 2 or len(lats) != len(lons):
        eprint(
            f"error: flight {flight.get('flight_number')} has no usable route "
            f"(lats={len(lats)}, lons={len(lons)})."
        )
        return False

    # "Current time" drives both the plane's position and which weather we show.
    if current_time is None:
        take_off = flight.get("take_off_time")
        current_time = datetime.fromisoformat(take_off) if take_off else None

    # Fixed page layout so the map is always the same size, just zoomed: map
    # axes, colorbar axes, and (below the map) the legend each get a fixed rect.
    proj = ccrs.PlateCarree()
    fig = plt.figure(figsize=(12, 7.5))
    map_rect = [0.06, 0.30, 0.72, 0.55]   # [left, bottom, width, height]
    ax = fig.add_axes(map_rect, projection=proj)
    ax.set_extent(CONUS_EXTENT, crs=proj)

    # US basemap.
    ax.add_feature(cfeature.OCEAN, facecolor="#dbeaf7")
    ax.add_feature(cfeature.LAND, facecolor="#f4f1ea")
    ax.add_feature(cfeature.LAKES, facecolor="#dbeaf7", edgecolor="none")
    ax.add_feature(cfeature.COASTLINE, linewidth=0.6, edgecolor="#5a6b7b")
    ax.add_feature(cfeature.BORDERS, linewidth=0.6, edgecolor="#5a6b7b")
    ax.add_feature(cfeature.STATES, linewidth=0.4, edgecolor="#b5bcc4")

    origin = flight.get("origin_airport_icao", "ORIG")
    dest = flight.get("destination_airport_icao", "DEST")
    dest_ll = (lats[-1], lons[-1])

    # Split the filed route at the aircraft's current position.
    frac = flight_fraction(flight, current_time)
    plane_lat, plane_lon, heading, flown, remaining = split_at_fraction(lats, lons, frac)

    # Weather overlay: composite reflectivity on the radar right now. Rerouting
    # additionally looks ahead (now .. now+LOOKAHEAD_MIN) so the aircraft avoids
    # storms it is about to reach, not just the cells beneath it.
    wx_label = None
    severity = None
    wx_target = current_time or datetime.now(timezone.utc)
    if weather and snapshot_dir:
        refc = load_wx_matrix(snapshot_dir, wx_target, "refc")
        if refc is None:
            eprint("warning: no weather data found for this snapshot; skipping overlay.")
        else:
            refc_m, valid_from, valid_to = refc
            shown = np.where(refc_m < WX_MIN_DBZ, np.nan, refc_m)
            mesh = ax.imshow(
                shown, extent=WX_EXTENT, origin="upper", transform=proj,
                vmin=WX_MIN_DBZ, vmax=60, cmap="turbo", alpha=0.7, zorder=2,
            )
            cax = fig.add_axes([0.80, 0.30, 0.016, 0.55])
            cbar = fig.colorbar(mesh, cax=cax)
            cbar.set_label("Composite reflectivity (dBZ)")
            wx_label = (f"wx valid {valid_from:%Y-%m-%d %H:%M}Z  |  "
                        f"reroutes look ahead {LOOKAHEAD_MIN} min")
            severity = lookahead_severity_grid(
                snapshot_dir, wx_target, flight.get("cruise_altitude_ft"))

    # Over-demand sectors: count current occupancy and flag those over capacity
    # in this flight's altitude band, so reroutes can avoid saturated airspace.
    overload_mask = None
    over_sectors = []
    if use_sectors and snapshot_dir and all_flights is not None:
        if sectors is None:
            sectors = load_sectors(os.path.dirname(snapshot_dir))
        if sectors:
            loads = compute_sector_loads(all_flights, wx_target, sectors)
            band = flight_band(flight.get("cruise_altitude_ft"))
            over_sectors = overloaded_in_band(sectors, loads, band)
            if over_sectors:
                overload_mask = overload_mask_grid(over_sectors)

    # Already-flown portion of the route, drawn as faint history.
    if frac > 0 and len(flown[0]) >= 2:
        ax.plot(flown[1], flown[0], transform=proj, color="#95a5a6",
                linewidth=2.0, zorder=3, solid_capstyle="round")

    # Candidate routes FROM the current position to the destination, scored.
    remaining_nm = polyline_length_nm(remaining[0], remaining[1])
    route_severity = severity if remaining_nm > 10 else None
    routes = build_routes((plane_lat, plane_lon), dest_ll, remaining,
                          route_severity, overload_mask)
    _, goodness = score_routes([r["metrics"] for r in routes])
    cmap = plt.get_cmap("RdYlGn")
    baseline_dist = routes[0]["metrics"].distance_nm
    # Best (recommended) route: highest goodness among those clear of overload.
    clear_idx = [i for i, r in enumerate(routes)
                 if r["metrics"].sector_overload_nm <= 1.0]
    best_idx = max(clear_idx, key=lambda i: goodness[i]) if clear_idx else -1

    # Zoom the map to just the relevant area: every route, the flown track and
    # the endpoints. Grow the box to the map axes' aspect so it fills the fixed
    # rectangle without distortion.
    coord_seqs = [(flown[0], flown[1])] + [(r["lats"], r["lons"]) for r in routes]
    coord_seqs.append(([lats[0], lats[-1]], [lons[0], lons[-1]]))
    fig_w, fig_h = fig.get_size_inches()
    target_aspect = (map_rect[2] * fig_w) / (map_rect[3] * fig_h)
    view = fit_extent_to_aspect(view_extent(coord_seqs), target_aspect)

    # Shade over-demand sectors that fall within the view, as context.
    if over_sectors:
        w, e, s, n = view
        visible = [sec for sec in over_sectors
                   if not (sec["geom"].bounds[2] < w or sec["geom"].bounds[0] > e
                           or sec["geom"].bounds[3] < s or sec["geom"].bounds[1] > n)]
        if visible:
            ax.add_geometries(
                [sec["geom"] for sec in visible], crs=proj,
                facecolor="#e74c3c", alpha=0.18, edgecolor="#c0392b",
                linewidth=1.2, hatch="xx", zorder=2.5,
            )
            for sec in visible:
                c = sec["geom"].representative_point()
                ax.annotate(f"{sec['name']}\n{sec['load']}/{sec['cap']}",
                            (c.x, c.y), transform=proj, ha="center", va="center",
                            fontsize=6.5, fontweight="bold", color="#7b241c",
                            zorder=8)

    legend_handles = []
    for idx, r in enumerate(routes):
        m = r["metrics"]
        is_baseline = idx == 0
        crosses_overload = m.sector_overload_nm > 1.0
        if crosses_overload:
            # Routed through a saturated sector: drawn red. A reroute option here
            # was considered and rejected; the filed plan here is a warning.
            color, linestyle, lw, z = "#c0392b", ":", 2.2, 6
            note = ("  ⚠ on plan through overloaded sector" if is_baseline
                    else "  ✗ via overloaded sector — not taken")
        else:
            color = cmap(float(goodness[idx]))
            linestyle = "-" if is_baseline else "--"
            lw = 3.2 if idx == best_idx else (2.6 if is_baseline else 1.8)
            z = 6 if idx == best_idx else (5 if is_baseline else 4)
            note = "  ✓ chosen" if idx == best_idx else ""
        ax.plot(r["lons"], r["lats"], transform=proj, color=color,
                linewidth=lw, linestyle=linestyle, zorder=z,
                solid_capstyle="round")
        extra = m.distance_nm - baseline_dist
        extra_txt = "on plan" if is_baseline else f"{extra:+.0f} nm"
        score_txt = "" if crosses_overload else f"  score {goodness[idx] * 100:.0f}"
        label = f"{r['name']}: {m.distance_nm:.0f} nm ({extra_txt}){score_txt}{note}"
        legend_handles.append(Line2D([0], [0], color=color, linewidth=lw,
                                     linestyle=linestyle, label=label))

    # Legend below the map so it never covers the route or sectors.
    ax.legend(handles=legend_handles, loc="upper left",
              bbox_to_anchor=(0.0, -0.03), borderaxespad=0.0, fontsize=8,
              title="reroutes from current position (higher = better)",
              title_fontsize=8, framealpha=1.0, alignment="left")

    # Emphasize endpoints.
    ax.plot(lons[0], lats[0], transform=proj, marker="o", markersize=9,
            color="#2f9e44", zorder=6)
    ax.plot(lons[-1], lats[-1], transform=proj, marker="*", markersize=16,
            color="#e8590c", zorder=6)
    ax.annotate(origin, (lons[0], lats[0]), transform=proj,
                xytext=(6, 6), textcoords="offset points",
                fontsize=9, fontweight="bold", color="#2b6a2f", zorder=7)
    ax.annotate(dest, (lons[-1], lats[-1]), transform=proj,
                xytext=(6, 6), textcoords="offset points",
                fontsize=9, fontweight="bold", color="#b34700", zorder=7)

    # Airplane icon at the current position, pointing along the route.
    ax.text(plane_lon, plane_lat, "✈", transform=proj,
            fontsize=22, ha="center", va="center",
            color="#1c2833", zorder=12,
            rotation=heading + PLANE_GLYPH_BASE_DEG, rotation_mode="anchor")

    ax.set_extent(view, crs=proj)
    ax.set_aspect("auto")  # fill the fixed rectangle (view already matches its aspect)

    subtitle_bits = []
    if flight.get("cruise_altitude_ft") is not None:
        subtitle_bits.append(f"FL{int(flight['cruise_altitude_ft']) // 100:03d}")
    if flight.get("cruise_speed_kt") is not None:
        subtitle_bits.append(f"{flight['cruise_speed_kt']} kt")
    subtitle = "   ".join(subtitle_bits)

    now_txt = ""
    if current_time is not None:
        now_txt = f"\nnow {current_time:%Y-%m-%d %H:%M}Z  ({frac * 100:.0f}% en route)"

    ax.set_title(
        f"{flight.get('flight_number')}   {origin} → {dest}\n"
        f"dep {flight.get('take_off_time')}"
        + (f"   |   {subtitle}" if subtitle else "")
        + now_txt
        + (f"\n{wx_label}" if wx_label else ""),
        fontsize=11,
    )

    # Branding: "don't crash" logo in the figure's upper-left margin.
    draw_logo(fig)

    # No bbox_inches="tight": keep a constant output size regardless of zoom.
    fig.savefig(output, dpi=150)
    print(f"Saved map to {output}")
    if show:
        plt.show()
    plt.close(fig)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Plot a flight's planned waypoint route on a US map.",
    )
    parser.add_argument(
        "-f", "--flight", dest="flight_number", required=True,
        help="airline flight id, e.g. UAL2279",
    )
    parser.add_argument(
        "-d", "--date", required=True,
        help="snapshot date, YYYY-MM-DD (UTC)",
    )
    parser.add_argument(
        "--bundle", default="hackathon_data_bundle",
        help="path to the data bundle (default: hackathon_data_bundle)",
    )
    parser.add_argument(
        "-o", "--output", default=None,
        help="output PNG path (default: flight_<FLIGHT>_<DATE>.png)",
    )
    parser.add_argument(
        "--show", action="store_true",
        help="open an interactive window in addition to saving the PNG",
    )
    parser.add_argument(
        "--no-weather", dest="weather", action="store_false",
        help="skip the weather overlay and weather-aware rerouting",
    )
    parser.add_argument(
        "--no-sectors", dest="sectors", action="store_false",
        help="skip sector over-demand computation and avoidance",
    )
    parser.add_argument(
        "-t", "--time", default=None,
        help="'current' time during the flight, ISO 8601 (e.g. "
             "2026-03-04T20:30 or just 20:30); positions the plane and selects "
             "the weather. Defaults to the flight's takeoff time.",
    )
    args = parser.parse_args(argv)

    if not os.path.isdir(args.bundle):
        eprint(f"error: bundle directory not found: {args.bundle}")
        return 2

    snapshot_dir = find_snapshot_dir(args.bundle, args.date)
    if snapshot_dir is None:
        dates = available_dates(args.bundle)
        eprint(f"error: no snapshot for date {args.date!r}.")
        eprint("Available dates:")
        for d in dates:
            eprint(f"  {d}")
        return 2

    try:
        payload = load_routes(snapshot_dir)
    except (OSError, ValueError) as exc:
        eprint(f"error: could not read routes from {snapshot_dir}: {exc}")
        return 2

    flights = payload.get("flights", [])
    matches = find_flights(flights, args.flight_number)
    if not matches:
        eprint(
            f"error: flight {args.flight_number!r} not found in snapshot "
            f"{os.path.basename(snapshot_dir)} ({len(flights)} flights)."
        )
        samples = sorted({str(f.get("flight_number")) for f in flights})[:12]
        if samples:
            eprint("Example flight numbers in this snapshot: " + ", ".join(samples))
        return 1

    if len(matches) > 1:
        eprint(
            f"warning: {len(matches)} legs match {args.flight_number!r} in this "
            f"snapshot; plotting the first. Other matches:"
        )
        for i, f in enumerate(matches):
            marker = "  -> " if i == 0 else "     "
            eprint(f"{marker}[{i}] {describe_leg(f)}")

    flight = matches[0]
    output = args.output or f"flight_{flight.get('flight_number')}_{args.date}.png"

    try:
        current_time = parse_current_time(args.time, flight)
    except ValueError:
        eprint(f"error: could not parse --time {args.time!r}; use ISO 8601 "
               f"like 2026-03-04T20:30 or a time of day like 20:30.")
        return 2

    ok = plot_flight(flight, output, args.show,
                     snapshot_dir=snapshot_dir, weather=args.weather,
                     current_time=current_time, all_flights=flights,
                     use_sectors=args.sectors)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
