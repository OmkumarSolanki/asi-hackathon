from __future__ import annotations

import gzip
import json
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import DATA_BUNDLE

SCENARIO_RE = re.compile(r"^asked_at_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$")
WX_FILE_RE = re.compile(
    r"^(?P<based>\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2})"
    r"_(?P<from>\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2})"
    r"_(?P<to>\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2})\.npz$"
)

LAT_MIN, LAT_MAX = 21.943, 55.7765
LON_MIN, LON_MAX = -135.0, -67.5
WX_ROWS, WX_COLS = 256, 358


def _parse_dt(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def _parse_wx_dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d_%H:%M:%S").replace(tzinfo=timezone.utc)


def list_scenarios() -> list[str]:
    out: list[str] = []
    for p in sorted(DATA_BUNDLE.iterdir()):
        m = SCENARIO_RE.match(p.name)
        if m and p.is_dir():
            out.append(m.group(1))
    return out


def scenario_dir(scenario_id: str) -> Path:
    return DATA_BUNDLE / f"asked_at_{scenario_id}"


def _open_text(path: Path) -> str:
    if path.suffix == ".gz" or path.name.endswith(".json.gz") or path.name.endswith(".geojson.gz"):
        with gzip.open(path, "rt") as f:
            return f.read()
    return path.read_text()


def _resolve_either(path_no_gz: Path) -> Path:
    if path_no_gz.exists():
        return path_no_gz
    gz = path_no_gz.with_suffix(path_no_gz.suffix + ".gz")
    if gz.exists():
        return gz
    raise FileNotFoundError(f"Neither {path_no_gz} nor {gz} exists")


@lru_cache(maxsize=None)
def load_routes(scenario_id: str) -> dict[str, Any]:
    path = _resolve_either(scenario_dir(scenario_id) / "routes.json")
    data = json.loads(_open_text(path))
    for f in data["flights"]:
        f["take_off_time_dt"] = _parse_dt(f["take_off_time"])
        f["scheduled_landing_time_dt"] = _parse_dt(f["scheduled_landing_time"])
        f["lats"] = np.asarray(f["lats"], dtype=np.float64)
        f["lons"] = np.asarray(f["lons"], dtype=np.float64)
        f["flight_id"] = f"{f['flight_number']}|{f['take_off_time']}|{f['origin_airport_icao']}"
    data["asked_at_dt"] = _parse_dt(data["asked_at"])
    data["window_start_dt"] = _parse_dt(data["window_start"])
    data["window_end_dt"] = _parse_dt(data["window_end"])
    return data


@lru_cache(maxsize=1)
def load_sectors() -> dict[str, Any]:
    path = _resolve_either(DATA_BUNDLE / "sectors.geojson")
    return json.loads(_open_text(path))


@lru_cache(maxsize=None)
def list_weather_files(scenario_id: str, kind: str) -> list[dict[str, Any]]:
    """List wx files for a scenario, sorted by valid_from. kind = 'refc' or 'retop'."""
    wx_dir = scenario_dir(scenario_id) / "wx" / kind
    if not wx_dir.exists():
        return []
    entries: list[dict[str, Any]] = []
    for p in wx_dir.iterdir():
        m = WX_FILE_RE.match(p.name)
        if not m:
            continue
        entries.append({
            "path": p,
            "based_at": _parse_wx_dt(m.group("based")),
            "valid_from": _parse_wx_dt(m.group("from")),
            "valid_to": _parse_wx_dt(m.group("to")),
        })
    entries.sort(key=lambda e: e["valid_from"])
    return entries


@lru_cache(maxsize=512)
def load_wx_frame(path_str: str) -> np.ndarray:
    return np.load(path_str)["matrix"]


def find_wx_frame_at(scenario_id: str, kind: str, t: datetime) -> np.ndarray | None:
    entries = list_weather_files(scenario_id, kind)
    if not entries:
        return None
    # Find the strip whose [valid_from, valid_to) contains t.
    for e in entries:
        if e["valid_from"] <= t < e["valid_to"]:
            return load_wx_frame(str(e["path"]))
    # Fallback: clamp to nearest by valid_from.
    if t < entries[0]["valid_from"]:
        return load_wx_frame(str(entries[0]["path"]))
    return load_wx_frame(str(entries[-1]["path"]))


def latlon_to_wx_ij(lat: float, lon: float) -> tuple[int, int] | None:
    if lat < LAT_MIN or lat > LAT_MAX or lon < LON_MIN or lon > LON_MAX:
        return None
    i = int((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * WX_ROWS)
    j = int((lon - LON_MIN) / (LON_MAX - LON_MIN) * WX_COLS)
    i = max(0, min(WX_ROWS - 1, i))
    j = max(0, min(WX_COLS - 1, j))
    return i, j


def wx_ij_to_latlon(i: int, j: int) -> tuple[float, float]:
    lat = LAT_MAX - (i + 0.5) / WX_ROWS * (LAT_MAX - LAT_MIN)
    lon = LON_MIN + (j + 0.5) / WX_COLS * (LON_MAX - LON_MIN)
    return lat, lon
