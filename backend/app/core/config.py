from pathlib import Path
import os
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")

_data_bundle_env = os.getenv("DATA_BUNDLE_PATH")
if _data_bundle_env:
    _p = Path(_data_bundle_env)
    DATA_BUNDLE = _p if _p.is_absolute() else (ROOT / _p).resolve()
else:
    DATA_BUNDLE = ROOT / "hackathon_data_bundle"
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
CACHE_DIR = ROOT / "backend" / "app" / "data" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
