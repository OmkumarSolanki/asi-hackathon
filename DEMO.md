# Demo — WX Advisory

3-minute walk-through. Hero scenario: **2025-07-14T22:35Z** — peak summer convection across the Midwest/Plains.

## Pre-flight (60s before)
- Backend up: `cd backend && source .venv/bin/activate && uvicorn app.main:app --port 8000`
- Frontend up: `cd frontend && npm run dev`
- Browser at `http://localhost:5173`
- Hero scenario should auto-load. Time scrubber at `21:52Z`.

## Demo script

### 0:00 — 0:25 · Set the stage
> "We're looking at every commercial flight over CONUS at 9:52 PM Eastern on July 14, 2025. The orange-and-red mesh is real HRRR weather radar. Those are the convective storms our 14,000 flights have to deal with."

Action: open browser. Pan map to Midwest. Drag time scrubber forward a couple frames — let judges see the storm advance.

### 0:25 — 0:50 · The WX Hotlist
> "Tyler told us pilots want a tool that says 'here's what's going to break, and what to do about it.' Top-left, our WX Hotlist: 8 aircraft are flying planned routes straight into convection right now. The one at the top — SWA2101 from Kansas City to New Orleans — has the worst encounter: 276 dBZ peak. Let's brief that one."

Action: click `SWA2101` in the WX Hotlist (amber pulse).

### 0:50 — 1:30 · The Advisory
> "Right-side panel — we hand-off to the cockpit advisory channel. Hit Request Advisory."

Action: click **Request Advisory**.

> "What just happened: we generated 7 candidate trajectories, sampled the weather grid along each one, checked every sector capacity along the path, ran an A* search to avoid storms, scored fuel and time deltas with the OpenAP model, pulled the destination's historical METAR, and called Claude to write the brief. About 2 seconds."

> "Recommendation: South Arc. Fuel impact plus 287 pounds, time impact actually minus 22 minutes — south arc benefits from upper-level winds. Confidence: HIGH."

> "Below that, the voice brief. ATC-style, first-person — meant to be read aloud."

Action: let the briefing breathe for 3-4 seconds.

### 1:30 — 2:05 · Options + Rejections
> "Switch to Options. Three viable. Then — and this is the part engineers will care about — we surface what we considered and rejected. Hard Right and Deviate 20 Right hit sector LOW_345 at 102% capacity. We won't recommend them. Notice the dashed red lines on the map — those are the rejections drawn in. Pilots and dispatchers see why we said no, not just what we said yes to."

Action: click **Options** tab. Hover over each option (highlight).

### 2:05 — 2:35 · The Killer Tab — Crowd
> "This is what no one else has. Switch to Crowd."

Action: click **Crowd**.

> "STRONG NO. 159 of 170 nearby flights have filed routes that detour around this storm — median offset 52 nautical miles. The airlines' own dispatch systems have already voted that this is dangerous. We're surfacing that vote to the cockpit."

> "Tyler asked us 'what happened to the last people who went through this?' This is the closest honest answer the data lets us give: not what they did after the fact — but what their flight plans say about whether they were willing to risk it. That's the crowd-forecast signal."

### 2:35 — 2:55 · Archive
> "Last tab: Archive. We replayed all 11 scenarios in our bundle, logged every flight's weather encounter as a synthetic PIREP record — 12,000+ encounters. For any new weather query, we do k-NN over the weather signature and return the closest historical analogs. Real grounding for the Claude brief, not made-up numbers."

Action: click **Archive**. Show analog count + top matches.

### 2:55 — 3:00 · Close
> "One pilot. One call. Ten seconds. Multiplied across 45,000 daily flights, that's the 90 million minutes of delay we'd start chipping at."

## Backup plays (if something breaks)

- **Backend timeout on Advise:** Reload page, pick a simpler flight from the hotlist (lower row).
- **Map doesn't render WX:** Toggle WX layer off and on in the time scrubber.
- **Claude API rate-limit:** Brief text falls back to a deterministic generator. Demo still works.
- **Internet down (no METAR):** Landing-weather strip just hides. Rest of UI unaffected.

## Hero flight roster (in order of demo preference)

1. **SWA2101** KMCI→KMSY, 1 encounter, 276 dBZ peak — the primary
2. **ASA517** KFLL→KSEA, 2 encounters, 210 dBZ — solid backup
3. **UCA4290** KTUL→KIAH, 2 encounters, 204 dBZ — third option

## Phrases worth memorizing

- "We hand-off to the cockpit advisory channel."
- "The airlines' own dispatch systems have already voted."
- "We're surfacing the vote to the cockpit."
- "Real grounding for the brief, not made-up numbers."
- "One pilot. One call. Ten seconds."
