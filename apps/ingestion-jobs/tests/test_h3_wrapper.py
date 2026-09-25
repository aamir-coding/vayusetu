import pytest
from src.earthEngineIngest import latlng_to_operational_h3, OPERATIONAL_H3_RES

def test_latlng_to_operational_h3():
    # Delhi Connaught Place coordinates
    lat, lng = 28.6315, 77.2167
    cell = latlng_to_operational_h3(lat, lng, OPERATIONAL_H3_RES)

    assert isinstance(cell, str)
    assert len(cell) == 15