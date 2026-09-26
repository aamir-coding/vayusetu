from datetime import datetime, timedelta, timezone

import pytest

from vayusetu_ingest.jobs import cpcb, openaq

T0 = datetime(2026, 9, 20, 0, tzinfo=timezone.utc)


def hourly(value, hours=30, start=T0):
    return {start + timedelta(hours=h): value for h in range(hours)}


class TestNormalize:
    def test_units(self):
        assert openaq.normalize("pm25", 80, "µg/m³") == 80
        assert openaq.normalize("pm25", 80, "Âµg/m³") == 80  # OpenAQ's mis-encoded unit string
        assert openaq.normalize("no2", 10, "ppb") == pytest.approx(18.8)
        assert openaq.normalize("co", 1000, "ppb") == pytest.approx(1.145)  # -> mg/m3
        assert openaq.normalize("co", 2000, "µg/m³") == pytest.approx(2.0)
        assert openaq.normalize("pm10", -5, "µg/m³") is None

    def test_hour_bucket_uses_period_midpoint(self):
        r = {"period": {"datetimeFrom": {"utc": "2026-09-22T23:30:00Z"}}}
        assert openaq.hour_of(r) == datetime(2026, 9, 23, 0, tzinfo=timezone.utc)


class TestRolling:
    def test_24h_mean_needs_16_hours(self):
        series = {"PM2.5": hourly(45, hours=15)}
        assert openaq.rolling_sub_indices(series, [T0 + timedelta(hours=14)]) == {}
        series = {"PM2.5": hourly(45, hours=16)}
        out = openaq.rolling_sub_indices(series, [T0 + timedelta(hours=15)])
        assert out[T0 + timedelta(hours=15)]["PM2.5"] == 75  # 45 ug/m3 -> 75

    def test_ozone_uses_8h_window(self):
        series = {"OZONE": {**hourly(10, hours=20), **hourly(150, hours=8, start=T0 + timedelta(hours=20))}}
        t = T0 + timedelta(hours=27)
        assert openaq.rolling_sub_indices(series, [t])[t]["OZONE"] == pytest.approx(172, abs=1)

    def test_rows_carry_station_aqi(self):
        series = {"PM2.5": hourly(100), "PM10": hourly(120), "NO2": hourly(30)}
        start = end = T0 + timedelta(hours=29)
        rows = openaq.ground_truth_rows("s1", "S1", "8828308281fffff", series, start, end, "now")
        assert {r["pollutant_id"] for r in rows} == {"PM2.5", "PM10", "NO2"}
        assert {r["aqi"] for r in rows} == {max(r["pollutant_avg"] for r in rows)}
        assert rows[0]["source"] == "CPCB_VIA_OPENAQ" and rows[0]["aqi_category"] == "poor"  # PM2.5 100 ug/m3 -> 232


def test_feed_stations_are_rekeyed_onto_registry():
    gt = [{"station_id": "anand-vihar-delhi-dpcc"}, {"station_id": "new-site"}]
    feed_stations = [
        {"station_id": "anand-vihar-delhi-dpcc", "lat": 28.6469, "lng": 77.3160},
        {"station_id": "new-site", "lat": 28.9, "lng": 77.0},
    ]
    registry = [{"station_id": "anand-vihar-new-delhi-dpcc", "lat": 28.6468, "lng": 77.3161}]
    rows, unmatched = cpcb.align_to_registry(gt, feed_stations, registry)
    assert rows[0]["station_id"] == "anand-vihar-new-delhi-dpcc"
    assert [s["station_id"] for s in unmatched] == ["new-site"]
