"""CPCB National AQI (NAQI) arithmetic.

Two inputs need it:
  * The data.gov.in real-time feed reports per-pollutant *sub-indices*
    (its CO values sit on the 0-500 index scale, not mg/m3). Station AQI is
    the MAX sub-index, and CPCB only publishes it when >= 3 pollutants are
    reported and at least one is PM2.5 or PM10.
  * Raw concentrations (Air Quality API pollutants, field-worker sensor
    readings) need the breakpoint tables to become sub-indices.
"""

from __future__ import annotations

from collections.abc import Mapping

CATEGORY_BANDS: list[tuple[int, str]] = [
    (50, "good"),
    (100, "satisfactory"),
    (200, "moderate"),
    (300, "poor"),
    (400, "very_poor"),
    (500, "severe"),
]

# (conc_lo, conc_hi, index_lo, index_hi); units ug/m3 except CO in mg/m3.
BREAKPOINTS: dict[str, list[tuple[float, float, int, int]]] = {
    "PM10": [(0, 50, 0, 50), (51, 100, 51, 100), (101, 250, 101, 200), (251, 350, 201, 300), (351, 430, 301, 400), (431, 1000, 401, 500)],
    "PM2.5": [(0, 30, 0, 50), (31, 60, 51, 100), (61, 90, 101, 200), (91, 120, 201, 300), (121, 250, 301, 400), (251, 500, 401, 500)],
    "NO2": [(0, 40, 0, 50), (41, 80, 51, 100), (81, 180, 101, 200), (181, 280, 201, 300), (281, 400, 301, 400), (401, 1000, 401, 500)],
    "OZONE": [(0, 50, 0, 50), (51, 100, 51, 100), (101, 168, 101, 200), (169, 208, 201, 300), (209, 748, 301, 400), (749, 1000, 401, 500)],
    "CO": [(0, 1.0, 0, 50), (1.1, 2.0, 51, 100), (2.1, 10, 101, 200), (10.1, 17, 201, 300), (17.1, 34, 301, 400), (34.1, 50, 401, 500)],
    "SO2": [(0, 40, 0, 50), (41, 80, 51, 100), (81, 380, 101, 200), (381, 800, 201, 300), (801, 1600, 301, 400), (1601, 2000, 401, 500)],
    "NH3": [(0, 200, 0, 50), (201, 400, 51, 100), (401, 800, 101, 200), (801, 1200, 201, 300), (1201, 1800, 301, 400), (1801, 2400, 401, 500)],
}

POLLUTANT_ALIASES = {
    "PM2.5": "PM2.5", "PM25": "PM2.5", "pm25": "PM2.5",
    "PM10": "PM10", "pm10": "PM10",
    "NO2": "NO2", "no2": "NO2",
    "OZONE": "OZONE", "O3": "OZONE", "o3": "OZONE",
    "CO": "CO", "co": "CO",
    "SO2": "SO2", "so2": "SO2",
    "NH3": "NH3", "nh3": "NH3",
}


def normalize_pollutant(pid: str | None) -> str | None:
    return POLLUTANT_ALIASES.get((pid or "").strip()) if pid else None


def category(aqi: float | None) -> str | None:
    if aqi is None:
        return None
    for upper, name in CATEGORY_BANDS:
        if aqi <= upper:
            return name
    return "severe"


def sub_index(pollutant: str, concentration: float | None) -> int | None:
    """Linear interpolation inside the CPCB band. A value in the gap between
    two integer breakpoints (e.g. PM2.5 30.4) maps to the upper band's floor."""
    table = BREAKPOINTS.get(pollutant)
    if table is None or concentration is None or concentration < 0:
        return None
    for c_lo, c_hi, i_lo, i_hi in table:
        if concentration <= c_hi:
            c_lo = min(c_lo, concentration)
            return round(i_lo + (i_hi - i_lo) * (concentration - c_lo) / (c_hi - c_lo)) if c_hi > c_lo else i_lo
    return 500


def station_aqi(sub_indices: Mapping[str, float | None]) -> int | None:
    """CPCB rule: max sub-index, only with >= 3 pollutants incl. PM2.5 or PM10."""
    present = {p: v for p, v in sub_indices.items() if v is not None}
    if len(present) < 3 or not ({"PM2.5", "PM10"} & present.keys()):
        return None
    return round(max(present.values()))
