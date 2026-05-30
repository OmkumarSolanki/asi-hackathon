from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import FRONTEND_URL
from app.routers import scenarios as scenarios_router

app = FastAPI(title="Pilot Weather Advisory")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scenarios_router.router, prefix="/api")


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok", "service": "pilot-weather-advisory"}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "healthy"}
