# Demo — Don't Crash! Course-Corrections Cockpit

~3-minute walk-through. Good hero flight: **SWA3209 KIND→KMCO** on **2025-07-08**
around **22:00Z** — it threads a saturated HIGH sector and convection en route, so
every feature lights up.

## Pre-flight (60s before)
- One server: `./start.sh` (or `.venv/bin/python webapp.py`).
- Browser at `http://127.0.0.1:5000/?flight=SWA3209&date=2025-07-08&time=2025-07-08T22:00`
- The flight auto-loads and the scrubber starts near 22:00Z.
- (First advisory builds the analog cache once — warm it before the demo by clicking
  **Suggest reroutes** on this flight beforehand.)

## Demo script

### 0:00 — 0:25 · Set the stage
> "Every commercial flight over CONUS at this moment. The orange-and-red mesh is
> NEXRAD-style radar. Drag the timeline — the aircraft and surrounding traffic move
> live, and the storms advance. Our flight, SWA3209, is heading into it."

Action: drag the scrubber a few frames; pan/zoom the map.

### 0:25 — 0:55 · Route planning (haxney engine)
> "Hit Suggest reroutes. We run an A\* search from the aircraft's current position
> that avoids storms forecast over the next 30 minutes and sectors already at
> capacity, then score each option on distance, weather severity, and sector
> overload. The recommended detour is highlighted; rejected ones that cross a
> saturated sector are drawn dashed-red."

Action: click **⟳ Suggest reroutes**. Click a card to expand fuel/time deltas.

### 0:55 — 1:40 · The AI Advisory
> "As soon as we have a recommendation, the ADVISORY card briefs the cockpit. The
> brief is written by Claude — but every number is real: it comes from the same
> structured payload we computed, so it can't make things up."

Action: read the ◆ ADVISORY brief aloud (5–7 ATC-style lines), point out the
CONF rating.

### 1:40 — 2:20 · Crowd-Forecast
> "Under the brief: the crowd-forecast signal. STRONG NO — hundreds of nearby
> flights have *filed* routes that detour around this weather. The airlines' own
> dispatch systems already voted it's dangerous, and we surface that vote to the
> cockpit."

Action: point to the CROWD-FORECAST verdict + headline in the advisory card.

### 2:20 — 2:45 · Historical analogs
> "Below that, HISTORICAL ANALOGS. We replayed every flight in every scenario and
> logged each hazardous weather encounter as a synthetic PIREP. For this cell we do
> k-NN over the weather signature and return the closest past matches — real
> grounding for the brief."

### 2:45 — 3:00 · Winds + landing, then close
> "Top-right WIND toggle overlays surface winds — green calm, red ≥40 kt. And the
> destination strip shows live landing weather at KMCO: wind, gusts, crosswind,
> any warnings. One pilot, one call, ten seconds."

Action: toggle **WIND**; point to the DEST WX strip (top-left).

## Backup plays (if something breaks)
- **Claude rate-limit / no key:** the brief falls back to deterministic text — demo still works.
- **Internet down (no METAR):** winds fall back to a synthetic field; the landing strip shows "NO DATA". Everything else is offline-capable (bundled basemap).
- **First advisory is slow:** it's building the analog cache — warm it once before the demo.

## Phrases worth memorizing
- "A\* around the storms it's about to reach, and around full sectors."
- "Every number in the brief is real — Claude writes the words, not the data."
- "The airlines' own dispatch systems already voted."
- "Real grounding for the brief, not made-up numbers."
