from __future__ import annotations

"""Fuel model.

Primary path: OpenAP for accurate per-aircraft burn rate.
Fallback: lookup table by airline class. Honest in demo about being a model.
"""

from functools import lru_cache

# Airline ICAO prefix → typical fleet aircraft type (heuristic)
AIRLINE_TO_TYPE: dict[str, str] = {
    # Majors → typical workhorse domestic widebody/narrowbody
    "UAL": "B739",  # United narrowbody
    "AAL": "B738",  # American
    "DAL": "B739",  # Delta
    "SWA": "B737",  # Southwest
    "JBU": "A320",  # JetBlue
    "ASA": "B739",  # Alaska
    "SKW": "CRJ7",  # SkyWest regional
    "RPA": "E175",  # Republic
    "FFT": "A320",  # Frontier
    "NKS": "A320",  # Spirit
    "ENY": "E175",  # Envoy
    "EDV": "CRJ9",  # Endeavor
    "AAY": "A319",  # Allegiant
    "FDX": "B763",  # FedEx
    "UPS": "B763",  # UPS
    "HAL": "A21N",  # Hawaiian
    "QXE": "DH8D",  # Horizon
    "PDT": "E145",  # Piedmont
    "GJS": "CRJ9",  # GoJet
}

# Fallback fuel burn lookup (lb / nautical mile at cruise FL360)
# Source: industry rough averages. Used when OpenAP unavailable or type unknown.
BURN_LB_PER_NM: dict[str, float] = {
    # Narrowbody
    "B737": 9.5, "B738": 9.5, "B739": 10.0, "B73G": 9.5,
    "A319": 8.5, "A320": 9.5, "A321": 10.5, "A21N": 8.0,
    # Regional jets
    "E145": 5.0, "E170": 6.0, "E175": 6.5, "E190": 7.5,
    "CRJ2": 5.0, "CRJ7": 6.0, "CRJ9": 6.5,
    # Turboprop
    "DH8D": 4.0,
    # Widebody
    "B763": 18.0, "B772": 22.0, "B788": 16.0, "B789": 17.0,
    "A332": 19.0, "A333": 20.0, "A359": 17.0,
}

DEFAULT_TYPE = "B738"
DEFAULT_BURN = 9.5
RESERVE_FACTOR = 1.4  # reserve fuel multiplier on minimum trip burn


def aircraft_type_for(flight_number: str) -> str:
    prefix = flight_number[:3].upper()
    return AIRLINE_TO_TYPE.get(prefix, DEFAULT_TYPE)


@lru_cache(maxsize=1)
def _openap_available() -> bool:
    try:
        import openap  # noqa: F401
        return True
    except Exception:
        return False


def burn_rate_lb_per_nm(aircraft_type: str, cruise_alt_ft: float) -> float:
    """Return lb/nm at cruise. Tries OpenAP first, falls back to lookup."""
    if _openap_available():
        try:
            from openap import FuelFlow
            ff = FuelFlow(ac=aircraft_type)
            # OpenAP cruise fuel flow: kg/s. Convert to lb/nm assuming typical cruise speed.
            # Approx: 460 kt → 460 nm/h → 0.1278 nm/s. lb_per_s = ff * 2.20462. lb/nm = lb_per_s / 0.1278.
            tas_kt = 460.0
            mass_kg = ff.aircraft["limits"]["MTOW"] * 0.85
            burn_kg_s = ff.enroute(mass=mass_kg, tas=tas_kt, alt=cruise_alt_ft, path_angle=0)
            burn_lb_h = burn_kg_s * 2.20462 * 3600
            return float(burn_lb_h / tas_kt)
        except Exception:
            pass
    return BURN_LB_PER_NM.get(aircraft_type.upper(), DEFAULT_BURN)


def fuel_burn_lb(distance_nm: float, aircraft_type: str, cruise_alt_ft: float = 36000.0) -> float:
    return burn_rate_lb_per_nm(aircraft_type, cruise_alt_ft) * distance_nm


def planned_fuel_load_lb(filed_distance_nm: float, aircraft_type: str, cruise_alt_ft: float = 36000.0) -> float:
    return fuel_burn_lb(filed_distance_nm, aircraft_type, cruise_alt_ft) * RESERVE_FACTOR
