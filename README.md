# Don't Crash! — Course-Corrections Cockpit

A dark "cockpit" dashboard for weather- and sector-aware flight rerouting. Pick a
flight and scrub through its filed route; the map shows live radar, traffic,
over-demand ATC sectors, and ranked A\* reroutes from the aircraft's current
position. An **AI advisory** layer adds a Claude-written briefing, a
crowd-forecast signal, historical weather analogs, destination landing weather,
and a surface-winds layer.

> This is a merge of two ASI-hackathon takes. The **UI and route planning** come
> from [`haxney/asi-hackathon`](https://github.com/haxney/asi-hackathon) (Flask +
> vanilla-JS cockpit, A\* engine in `dont_crash.py`). The **additional advisory
> features** (AI briefing, crowd-forecast, PIREP analogs, METAR, winds, OpenAP
> fuel) are ported from the FastAPI/React version and now run inside the same
> Flask app — see `backend/app/`.

---

## Quick start

```bash
# 1) Env (optional but recommended)
cp .env.example .env
# edit .env -> set ANTHROPIC_API_KEY for live AI briefings
# (without it, briefings fall back to deterministic text)

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
webapp.py               Flask server (haxney base + advisory endpoints)
dont_crash.py           routing/weather/sector engine + A* + scoring (route planning)
web/                    vanilla-JS cockpit UI (haxney)
  index.html, static/{app.js,style.css,us_states.geojson,cities.json,logo.jpg}
backend/app/            advisory feature package (ported from the FastAPI version)
  core/                 geo math, data loaders, simulator, config
  services/             briefing (Claude), crowd_forecast, pirep (k-NN analogs),
                        metar, winds, fuel
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

Added advisory features (ported):

- **◆ ADVISORY card** (right panel) — a Claude-written ATC-style briefing with a
  confidence rating, generated from the chosen reroute and the signals below.
- **Crowd-forecast** — verdict (`STRONG/WEAK GO/NO`) for the weather cell ahead,
  based on how many nearby *filed* routes already detour around it.
- **Historical analogs** — k-NN over a synthetic PIREP archive (every flight in
  every scenario replayed offline) of similar past weather encounters.
- **Destination landing weather** (left strip) — historical METAR for the arrival
  airport: wind, gusts, visibility, crosswind, plus suitability warnings.
- **Surface winds layer** — `WIND` toggle (top-right) draws station wind vectors
  (green < 40 kt, red ≥ 40 kt), blending real METAR with a climatological fallback.
- **Aircraft-aware fuel** — burn rate from the OpenAP-backed fuel model (per
  airline/type) replaces the old flat rate, feeding the fuel readout and reroute
  fuel deltas.

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

Added advisory:

| Method | Path | What |
|---|---|---|
| GET | `/api/advisory?flight=&date=&time=` | AI brief + crowd + analogs + landing + fuel (cached) |
| GET | `/api/crowd?flight=&date=&time=` | crowd-forecast signal for the cell ahead |
| GET | `/api/analogs?flight=&date=&time=` | k-NN historical weather analogs |
| GET | `/api/landing?flight=&date=&time=` | destination METAR landing assessment |
| GET | `/api/winds?date=&time=` | METAR-derived wind at ~36 major airports |

The advisory endpoints map haxney's `(flight, date, time)` onto the ported
services (which key by scenario id + UTC time) and build on the existing flight
state — they do **not** replace the A\* route planning.

---

## Notes

- **AI briefing** uses Claude (`claude-sonnet-4-6`); set `ANTHROPIC_API_KEY` or it
  falls back to a deterministic brief from the same structured payload.
- **PIREP analogs** build a one-time cache (`backend/app/data/cache/`) on first
  use by scanning every scenario — the first `/api/advisory` is slower.
- **METAR/winds** hit the Iowa State Mesonet ASOS API; winds fall back to a
  synthetic climatological field and METAR returns "no data" gracefully offline.
