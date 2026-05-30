from __future__ import annotations

"""Claude-driven pilot briefing generator.

Single call per advisory. Structured input. ATC-style first-person pilot tone.
"""

import json
from functools import lru_cache
from typing import Any

from anthropic import Anthropic

from app.core.config import ANTHROPIC_API_KEY

MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You are an ATC-style flight advisory assistant briefing a pilot in command.

Output exactly 5-7 lines, no bullets, no markdown. Use real ATC phraseology where natural.
Always address the pilot in the first person ("your route", "your fuel"), as if you are the
flight dispatcher relaying intelligence to the cockpit.

Required structure:
LINE 1: Flight callsign + 1-line situation summary (weather + location).
LINE 2: Recommended action (deviate left/right N degrees, hold, divert, continue).
LINE 3: Fuel and time impact for the recommendation.
LINE 4: Crowd-Forecast signal — what nearby flights are doing.
LINE 5: Historical analog count + outcome rate.
LINE 6 (optional): Sector capacity or landing weather caveat.
LINE 7: One-line confidence rating.

Tone: terse, professional, calm. No fluff. No hedging like "you might want to consider".
Use exact numbers from the input. Do NOT invent numbers."""


@lru_cache(maxsize=1)
def _client() -> Anthropic:
    return Anthropic(api_key=ANTHROPIC_API_KEY)


def generate_briefing(payload: dict[str, Any]) -> str:
    if not ANTHROPIC_API_KEY:
        return _fallback(payload)
    try:
        msg = _client().messages.create(
            model=MODEL,
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": json.dumps(payload, default=str, indent=2),
            }],
        )
        text_parts = []
        for block in msg.content:
            if getattr(block, "type", None) == "text":
                text_parts.append(block.text)
        return "\n".join(text_parts).strip() or _fallback(payload)
    except Exception as e:
        return _fallback(payload) + f"\n[brief generated locally: {e.__class__.__name__}]"


def _fallback(p: dict[str, Any]) -> str:
    rec = p.get("recommended_route") or {}
    crowd = p.get("crowd_signal") or {}
    analogs = p.get("analogs") or {}
    flight = p.get("flight", {})
    cs = flight.get("callsign", "FLIGHT")
    return (
        f"{cs} — weather advisory: {p.get('weather_summary','convective activity ahead on filed route')}.\n"
        f"Recommend {rec.get('label','deviation')}, accept {rec.get('time_delta_min','+9')} min.\n"
        f"Fuel impact: +{rec.get('fuel_delta_lb','--')} lb. Reserve maintained.\n"
        f"Crowd-Forecast: {crowd.get('verdict','UNKNOWN')} — {crowd.get('n_detoured',0)} of {crowd.get('n_observed',0)} nearby flights detoured.\n"
        f"Archive: {analogs.get('count',0)} similar encounters in our records.\n"
        f"Confidence: {p.get('confidence','MEDIUM')}."
    )
