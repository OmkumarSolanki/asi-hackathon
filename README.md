# WX Advisory — Pilot Weather Decision Support

Cockpit decision-support tool. Given a flight and a moment in time, returns ranked route options with fuel cost, traffic-ahead intelligence, sector-aware constraints, weather-historical analogs, and an ATC-style briefing.

Built for the ASI hackathon. Hero scenario: **2025-07-14T22:35Z** — peak summer convection across the Midwest/Plains.

---

## Quick start

```bash
# 1) Env
cp .env.example .env
# edit .env -> set ANTHROPIC_API_KEY (required for live briefings;
# falls back to deterministic text without it)

# 2) Data bundle
# Drop the hackathon data bundle at ./hackathon_data_bundle/
# (gitignored, 226 MB — distributed out of band, not in this repo)

# 3) Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 4) Frontend (new terminal, from repo root)
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

One-shot launcher (kills anything on :8000 and :5173, then starts both):

```bash
./start.sh
```

Requirements: Python 3.12, Node 20+, a working `ANTHROPIC_API_KEY` for live briefings.

---

## Layout

```
backend/                FastAPI app
  app/
    core/               data loaders, geo math, simulator
    services/           reroute (A*), fuel (OpenAP-derived), PIREP archive,
                        crowd-forecast, METAR, advisor orchestrator, briefing (Claude)
    routers/            HTTP endpoints
    data/               cached k-NN indices
frontend/               React + Vite + MapLibre + Zustand
hackathon_data_bundle/  (gitignored) scenarios + HRRR weather + sectors
DEMO.md                 3-minute walk-through script
```

---

## Features in the UI

- **Map** — MapLibre, radar overlay (green ≤40 dBZ safe, red >40 hazard), ATC sector polygons coloured by load, all airborne flights at the scrubbed time.
- **Time scrubber** — full 18 h forecast window. Selecting a plane scopes the timeline to that flight's take-off → landing window and plots its weather encounters as clickable diamond markers.
- **Flight picker / WX hotlist** — flights ranked by drama score (severity × encounter count).
- **Advisory panel** — opens when a flight is selected. Brief / Options / Crowd / Archive tabs.
- **Compare** — in the Options tab, click 2-3 options to mark them; a CompareStrip ranks them on fuel/time/distance/wx/load and dots the winner.
- **Wind streamlines + station barbs** — toggleable; neutral colour below 25 kt, amber 25-40, red ≥40.
- **Deselect** — × button in the advisory panel header or in the timeline header returns to the full scenario view.

---

## How "Request Advisory" works

The endpoint is `POST /api/advise` with `{ scenario, flight, time }`. Everything below runs in **one** call (~2 s end-to-end on a warm cache).

`backend/app/services/advisor.py` is the orchestrator. The full pipeline:

1. **Resolve flight state** — load the flight's filed route, interpolate its position at the requested time, classify the phase (taxi / climb / cruise / descent). `core/simulator.flight_position_at`.

2. **Sample weather along the remaining filed path** — every 10 min of flight time, sample the HRRR composite reflectivity (`refc`) and echo-top (`retop`) grids at the projected position. Anything ≥40 dBZ where the echo top exceeds the cruise altitude is a hazardous encounter. `core/simulator.flight_weather_encounters`.

3. **Generate route candidates** — `services/reroute.generate_candidates` returns up to 7 trajectories:
   - `direct` — current filed path (baseline)
   - `right_mild` / `left_mild` — 20° deviation
   - `right_strong` / `left_strong` — hard detour
   - `north_arc` / `south_arc` — long lateral arcs
   Each non-direct candidate is an **A\*** search on a 0.5°×0.7° lat/lon grid (`astar_route`). The cost function blocks any cell where `refc ≥ 40 dBZ` and the echo top still exceeds cruise altitude, and (optionally) blocks cells inside sectors already at capacity.

4. **Evaluate each candidate** — `services/reroute.evaluate_route` samples the path every ~25 nm and computes:
   - `distance_nm`, `time_min`, `fuel_lb` (OpenAP-derived burn-rate model in `services/fuel.py`)
   - `weather_encounters` + `max_refc_dbz`
   - `sectors_transited` + `max_sector_load_pct`
   - `sector_violations` (any sector at ≥ capacity along the path)

5. **Filter + rank** —
   - Any non-direct candidate that still hits weather → **rejected** with reason `still crosses weather (N hits)`.
   - Any non-direct candidate with a sector violation → **rejected** with reason `sector violation: NAME`.
   - The rest are **viable**, sorted by `(weather_encounters × 1000) + distance_nm`. The detours come first; `direct` is appended last if it survived.

6. **Crowd-forecast signal** — `services/crowd_forecast.crowd_signal`. Looks at every other airborne flight passing near the first conflict point (or the current position if no conflict). A "detour" = its filed waypoints arc ≥2% further than great-circle direct, or carry ≥30 nm of perpendicular offset. Returns a verdict (`STRONG NO` / `WEAK NO` / `WEAK GO` / `STRONG GO` / `UNKNOWN`), counts, median deviation %, max offset nm, and example flights. This is the "what are the airlines' planners already doing about this weather" signal.

7. **Historical analogs** — `services/pirep.find_analogs`. Every flight across all 11 scenarios in the data bundle was replayed offline and every hazardous weather encounter logged as a synthetic PIREP record (~12 k rows). At query time we do a **k-NN** over the weather signature (`refc_dbz`, `retop_ft`, altitude margin) and return the closest 24. `analog_summary` reduces that to a count, scenarios touched, and `median_refc` / `p90_refc`. Skipped when there's no conflict.

8. **Fuel state** — `services/fuel.planned_fuel_load_lb` and `fuel_burn_lb`:
   - Starting load = filed-distance burn × **1.4** reserve factor.
   - Burned-so-far from the great-circle distance already flown.
   - Reserve = what's left after planned trip burn.

9. **Landing weather** — `services/metar.landing_assessment` pulls the destination ICAO's historical METAR (NOAA Iowa State Mesonet) for the scenario's actual date/time. Returns parsed wind/visibility plus any landing-suitability warnings (crosswind, IFR, gust spread).

10. **Confidence** — derived from the analog count: `HIGH ≥ 12` · `MEDIUM ≥ 4` · `LOW < 4`.

11. **Claude briefing** — `services/briefing.generate_briefing`. The entire structured payload (flight, current sector, encounters, options, rejected, recommended, crowd, analogs, fuel, landing weather, confidence) is JSON-dumped and sent to **Claude Sonnet 4.6** with a strict 5-7-line ATC-style system prompt. The model writes the voice brief; we do not invent numbers. If the API key is missing or the call fails, a deterministic fallback brief is generated from the same payload so the demo still works.

The full payload — `flight`, `current_sector`, `weather_summary`, `encounters_ahead`, `options`, `rejected`, `recommended_route`, `crowd_signal`, `analogs`, `fuel`, `landing_weather`, `confidence`, `briefing` — is returned in one response and rendered by `frontend/src/components/BriefingPanel.tsx`.

---

## Advisory panel tabs

- **Brief** — recommendation block, Claude voice brief, fuel budget bar, landing-weather strip.
- **Options** — every viable candidate, click to mark for compare (cap 3); a CompareStrip ranks them. Below that, the rejected list with reasons. Hover any option to highlight its path on the map.
- **Crowd** — verdict, headline, detour ratio bar, observed example flights' filed routes (also drawn on the map).
- **Archive** — analog count, median / P90 refc, top historical matches with similarity score.

---

## HTTP endpoints (FastAPI, `/api` prefix)

| Method | Path | What |
|---|---|---|
| GET  | `/api/scenarios` | list scenarios |
| GET  | `/api/scenarios/{sid}/flights?airborne_only=true&limit=N` | flights in scenario |
| GET  | `/api/scenarios/{sid}/timesteps` | 15-min weather frames |
| GET  | `/api/scenarios/{sid}/weather?t=ISO&kind=refc\|retop` | reflectivity grid at time |
| GET  | `/api/scenarios/{sid}/sectors?t=ISO&band=high\|low` | sector polygons + current load |
| GET  | `/api/scenarios/{sid}/winds?t=ISO` | METAR-derived wind at 36 airports |
| GET  | `/api/scenarios/{sid}/hero-flights?limit=N` | flights ranked by drama score |
| POST | `/api/advise` | the full advisory pipeline above |

Body for `/api/advise`:

```json
{ "scenario": "2025-07-14T22:35:00Z", "flight": "SWA2101", "time": "2025-07-14T21:52:00Z" }
```

---

## Demo

See [DEMO.md](./DEMO.md) for the 3-minute walk-through, hero-flight roster, and backup plays.
