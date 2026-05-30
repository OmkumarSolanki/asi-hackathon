# Don't Crash! — Course-Corrections Cockpit

A dark "cockpit" dashboard for weather- and sector-aware flight rerouting. Pick a
flight and scrub through its filed route; the map shows live radar, traffic,
over-demand ATC sectors, and ranked A\* reroutes from the aircraft's current
position. Additional layers add destination landing weather, a surface-winds
field, and an aircraft-aware fuel tracker.

> This is a merge of two ASI-hackathon takes. The **UI and route planning** come
> from [`haxney/asi-hackathon`](https://github.com/haxney/asi-hackathon) (Flask +
> vanilla-JS cockpit, A\* engine in `dont_crash.py`). The **additional features**
> (METAR landing weather, winds, OpenAP fuel) are ported from the FastAPI/React
> version and now run inside the same Flask app — see `backend/app/`.

---

## Quick start

```bash
# 1) Env (optional — defaults work out of the box)
cp .env.example .env

# 2) Data bundle
# Place the hackathon data bundle at ./hackathon_data_bundle/
# (gitignored, ~226 MB — distributed out of band)

# 3) Install + run
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python webapp.py            # http://127.0.0.1:5000
```

Or use the launcher:

```bash
./start.sh                            # prefers .venv, frees :5000, runs Flask
```

Open a scenario directly, e.g.:

```
http://127.0.0.1:5000/?flight=SWA3209&date=2025-07-08&time=2025-07-08T22:00
```

`flight`, `date`, `time` are query params; add `&suggest=1` to auto-evaluate
reroutes on load. The basemap and city labels are bundled, so the map works
offline; only METAR/winds need network (they degrade gracefully otherwise).

Requires Python 3.10+. Optional: `pip install -e ".[fuel]"` adds the OpenAP fuel
model (otherwise a per-aircraft lookup table is used).

---

## Layout

```
webapp.py               Flask server (haxney base + feature endpoints)
dont_crash.py           routing/weather/sector engine + A* + scoring (route planning)
web/                    vanilla-JS cockpit UI (haxney)
  index.html, static/{app.js,style.css,us_states.geojson,cities.json,logo.jpg}
backend/app/            feature package (ported from the FastAPI version)
  core/                 geo math, data loaders, simulator, config
  services/             metar, winds, fuel
hackathon_data_bundle/  (gitignored) scenarios + HRRR weather + ATC sectors
```

---

## Features in the UI

Base cockpit (haxney):

- **Map** — bundled CONUS basemap, NEXRAD-style radar overlay, over-demand sector
  hatching, live traffic, your aircraft interpolated client-side for instant scrub.
- **Time scrubber** — drag through the flight; traffic moves live, weather/state
  update on settle. A **⚡ marker** flags the most congested point (weather or a
  saturated sector) and pre-warms its reroutes in the background.
- **Suggest reroutes** — A\* alternates from the current position that avoid storms
  (forecast over the next `LOOKAHEAD_MIN`) and saturated sectors, ranked by a
  goodness score (distance + weather severity + sector overload). Pan/zoom/fit map.

Added features (ported):

- **Destination landing weather** (left strip) — historical METAR for the arrival
  airport: wind, gusts, visibility, crosswind, plus suitability warnings.
- **Surface winds layer** — `WIND` toggle (top-right) draws an interpolated wind
  field (green < 25 kt, amber 25–40, red ≥ 40), blending real METAR with a
  climatological fallback, and evolving as you scrub.
- **Cumulative fuel tracker** (in the scrubber) — fuel used / remaining / total,
  with the extra vs the filed plan, using the OpenAP-backed aircraft-aware burn
  rate; updates live as you scrub and accept reroutes.

---

## HTTP endpoints (Flask)

Base (haxney):

| Method | Path | What |
|---|---|---|
| GET | `/api/flights?date=&q=` | dates + (filtered) flight numbers |
| GET | `/api/flight?flight=&date=` | static flight meta + filed route |
| GET | `/api/state?flight=&date=&time=` | position, traffic, sectors, weather readouts |
| GET | `/api/traffic?flight=&date=&time=` | cheap traffic-only update (live scrub) |
| GET | `/api/reroutes?flight=&date=&time=` | on-demand A\* reroutes (cached) |
| GET | `/api/hotspot?flight=&date=` | most congested point + background pre-warm |
| GET | `/api/weather.png?date=&time=` | NEXRAD-style raster |

Added:

| Method | Path | What |
|---|---|---|
| GET | `/api/landing?flight=&date=&time=` | destination METAR landing assessment |
| GET | `/api/winds?date=&time=` | METAR-derived wind at ~36 major airports |

These endpoints map haxney's `(flight, date, time)` onto the ported services and
build on the existing flight state — they do **not** replace the A\* route planning.

---

## Notes

- **METAR/winds** hit the Iowa State Mesonet ASOS API; winds fall back to a
  synthetic climatological field and METAR returns "no data" gracefully offline.
