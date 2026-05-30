# Demo — Don't Crash! Course-Corrections Cockpit

~2–3-minute walk-through. Good hero flight: **SWA3209 KIND→KMCO** on **2025-07-08**
around **22:00Z** — it threads a saturated HIGH sector and convection en route, so
the reroute logic, fuel tracker, and weather layers all light up. (See
`scripts/find_demo_flights.py` for more candidates.)

## Pre-flight (60s before)
- One server: `./start.sh` (or `.venv/bin/python webapp.py`).
- Browser at `http://127.0.0.1:5000/?flight=SWA3209&date=2025-07-08&time=2025-07-08T22:00`
- The flight auto-loads and the scrubber starts near 22:00Z.

## Demo script

### 0:00 — 0:30 · Set the stage
> "Every commercial flight over CONUS at this moment. The orange-and-red mesh is
> NEXRAD-style radar — and it updates live as I scrub the timeline, along with the
> traffic and our aircraft. Our flight, SWA3209, is heading into it."

Action: drag the scrubber; point out the radar + traffic moving and the live
TIME / WX-AHEAD readouts in the top-right box.

### 0:30 — 1:10 · Route planning (haxney engine)
> "Hit Suggest reroutes. We run an A\* search from the aircraft's current position
> that avoids storms forecast over the next 30 minutes and sectors already at
> capacity, then score each option on distance, weather severity, and sector
> overload."

Action: click **⟳ Suggest reroutes**. Point out the color coding — **green =
recommended**, **blue = viable alternate**, **red dashed = rejected** (crosses a
full sector). Click an option; the cards show fuel/time/dBZ/aircraft inline.

### 1:10 — 1:40 · Follow the route + fuel tracker
> "Select a reroute and scrub forward — the aircraft now flies *that* path. The
> fuel tracker in the timeline shows fuel used, remaining, and total trip, with
> the extra burn this detour costs versus the filed plan. Re-suggest from here and
> the new options branch off the route I'm actually flying."

Action: select a route, scrub forward, watch **FUEL USED / REMAINING / TOTAL TRIP**
update with the amber deltas; re-suggest and select again to chain detours.

### 1:40 — 2:10 · Weather layers
> "The WIND toggle overlays an interpolated surface-wind field — green calm, amber
> moderate, red ≥40 kt — and it evolves as I scrub. The destination strip shows
> live landing weather at KMCO: wind, gusts, crosswind, and any warnings."

Action: toggle **WIND**; point to the **DEST WX** strip (top-left).

### 2:10 — close
> "One pilot, one call: see the weather, see who's rerouting around it, pick a
> path, and know exactly what it costs in fuel and time."

## Backup plays (if something breaks)
- **Internet down (no METAR):** winds fall back to a synthetic field; the landing
  strip shows "NO DATA". Everything else is offline-capable (bundled basemap).
- **Hotspot marker (⚡):** jump straight to the most congested point — its reroutes
  are pre-warmed, so they appear instantly.

## Phrases worth memorizing
- "Radar, traffic, winds — all live as you scrub."
- "A\* around the storms it's about to reach, and around full sectors."
- "Green is recommended, red dashed is rejected for crossing a full sector."
- "The fuel tracker tells you exactly what the detour costs."
