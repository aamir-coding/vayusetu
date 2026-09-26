from datetime import datetime, timezone

import h3
import pytest

from vayusetu_ingest import geo
from vayusetu_ingest.jobs import air_quality, cpcb, rollup, seed, weather


def feed(station, lat, lng, pollutant, avg, updated="26-09-2026 14:00:00"):
    return {"station": station, "latitude": str(lat), "longitude": str(lng), "last_update": updated,
            "pollutant_id": pollutant, "min_value": "1", "max_value": "999", "avg_value": str(avg),
            "city": "Delhi", "state": "Delhi"}


@pytest.fixture
def corridors():
    return geo.load_corridors()


class TestCpcb:
    def test_transform(self, corridors):
        records = [
            feed("Anand Vihar, Delhi - DPCC", 28.6469, 77.3160, "PM2.5", 312),
            feed("Anand Vihar, Delhi - DPCC", 28.6469, 77.3160, "NO2", 80),
            feed("Anand Vihar, Delhi - DPCC", 28.6469, 77.3160, "CO", 45),
            feed("Bandra, Mumbai - MPCB", 19.0596, 72.8295, "PM10", 90),
            feed("Chennai - CPCB", 13.08, 80.27, "PM2.5", 50),  # outside every corridor -> dropped
        ]
        rows, stations = cpcb.transform(records, corridors)
        delhi = [r for r in rows if r["station_id"] == "anand-vihar-delhi-dpcc"]
        assert len(delhi) == 3
        assert {r["aqi"] for r in delhi} == {312}  # station AQI on every pollutant row
        assert delhi[0]["aqi_category"] == "very_poor"
        # 14:00 IST -> 08:30 UTC
        assert (delhi[0]["observation_date"], delhi[0]["observation_hour"]) == ("2026-09-26", 8)
        assert h3.get_resolution(delhi[0]["h3_index"]) == 8
        mumbai = next(r for r in rows if r["station_id"].startswith("bandra"))
        assert mumbai["aqi"] is None  # one pollutant -> CPCB publishes no AQI
        assert {s["corridor_id"] for s in stations} == {"ncr-airshed", "mumbai-pune-corridor"}
        assert next(s for s in stations if s["station_id"].startswith("anand"))["agency"] == "SPCB"

    def test_bad_records_are_skipped(self, corridors):
        rows, _ = cpcb.transform([
            feed("X", "NA", 77.3, "PM2.5", 10),
            feed("Y", 28.6, 77.3, "Pb", 10),
            feed("Z", 28.6, 77.3, "PM2.5", 10, updated="garbage"),
        ], corridors)
        assert rows == []

    def test_station_doc_matches_contract(self, corridors):
        _, stations = cpcb.transform([feed("ITO, Delhi - CPCB", 28.628, 77.241, "PM10", 100)], corridors)
        doc = cpcb.station_doc(stations[0])
        assert set(doc) >= {"id", "name", "agency", "geo", "h3Index", "isOfficial", "lastReadingAt"}
        assert doc["agency"] == "CPCB"


class TestSeed:
    def test_corridor_doc_matches_alert_service_schema(self, corridors):
        ncr = next(c for c in corridors if c.id == "ncr-airshed")
        doc = seed.corridor_doc(ncr, "gs://b/corridors/ncr-airshed.geojson", ["s1"], "2026-09-26T00:00:00Z")
        assert set(doc) == {"id", "name", "states", "boundaryGeoJsonStorageUrl", "population",
                            "monitoringStationIds", "grapFrameworkActive", "createdAt", "grapThresholds"}
        assert set(doc["grapThresholds"]) == {"stage_1", "stage_2", "stage_3", "stage_4"}
        assert doc["grapThresholds"]["stage_1"] == {"aqiMin": 201, "aqiMax": 300}
        mh = next(c for c in corridors if c.id == "mumbai-pune-corridor")
        assert "grapThresholds" not in seed.corridor_doc(mh, "u", [], "t")

    def test_build_cells_marks_monitor_coverage(self, corridors):
        ncr = next(c for c in corridors if c.id == "ncr-airshed")
        station = {"station_id": "ito", "corridor_id": "ncr-airshed", "lat": 28.628, "lng": 77.241}
        rows = {r["h3_index"]: r for r in seed.build_cells([ncr], [station])}
        at_station = rows[geo.cell(28.628, 77.241)]
        assert at_station["has_monitor_within_radius"] and at_station["nearest_station_id"] == "ito"
        far = rows[geo.cell(28.0, 76.4)]
        assert not far["has_monitor_within_radius"]
        assert h3.get_resolution(at_station["h3_res7"]) == 7 and h3.get_resolution(at_station["h3_res4"]) == 4


class TestAirQuality:
    def test_to_row_converts_ppb_and_picks_cpcb_index(self):
        info = {
            "dateTime": "2026-09-25T20:00:00Z",
            "indexes": [{"code": "uaqi", "aqi": 40}, {"code": "ind_cpcb", "aqi": 245, "dominantPollutant": "pm25"}],
            "pollutants": [
                {"code": "pm25", "concentration": {"value": 101.0, "units": "MICROGRAMS_PER_CUBIC_METER"}},
                {"code": "no2", "concentration": {"value": 20.0, "units": "PARTS_PER_BILLION"}},
            ],
        }
        row = air_quality.to_row(info, {"h3_index": "x", "corridor_id": "ncr-airshed"}, "now")
        assert row["aqi"] == 245 and row["aqi_category"] == "poor" and row["dominant_pollutant"] == "PM2.5"
        assert row["no2_ugm3"] == pytest.approx(37.6)
        assert (row["observation_date"], row["observation_hour"]) == ("2026-09-25", 20)

    def test_sample_is_stable_and_per_corridor(self):
        cells = [{"h3_index": f"c{i}", "corridor_id": "a" if i % 2 else "b"} for i in range(50)]
        s1, s2 = air_quality.sample_cells(list(cells), 5), air_quality.sample_cells(list(reversed(cells)), 5)
        assert [c["h3_index"] for c in s1] == [c["h3_index"] for c in s2] or {c["h3_index"] for c in s1} == {c["h3_index"] for c in s2}
        assert sum(c["corridor_id"] == "a" for c in s1) == 5


class TestWeather:
    def test_units(self):
        hour = {"interval": {"startTime": "2026-09-26T05:00:00Z"}, "temperature": {"degrees": 31.5},
                "relativeHumidity": 60, "wind": {"direction": {"degrees": 290}, "speed": {"value": 18, "unit": "KILOMETERS_PER_HOUR"}},
                "precipitation": {"qpf": {"quantity": 0.4, "unit": "MILLIMETERS"}}}
        [row] = weather.observed_rows({"h3_index": "w", "corridor_id": "ncr-airshed"}, [hour], "now")
        assert row["wind_speed_ms"] == pytest.approx(5.0)
        assert row["observation_hour"] == 5 and row["source"] == "GOOGLE_WEATHER_API"

    def test_every_corridor_gets_weather_points(self, corridors):
        pts = weather.weather_points(corridors)
        assert {p["corridor_id"] for p in pts} == {"ncr-airshed", "mumbai-pune-corridor"}
        assert all(h3.get_resolution(p["h3_index"]) == 4 for p in pts)


class TestRollup:
    RES = {"sourceClassification": "vehicular_smog", "severityEstimate": 4, "confidenceScore": 0.8,
           "needsHumanReview": False, "crossValidation": {"agreementScore": 0.7}}

    def test_qualifies(self):
        assert rollup.qualifies(self.RES, 0.5, 0.4)
        assert not rollup.qualifies({**self.RES, "confidenceScore": 0.3}, 0.5, 0.4)
        assert not rollup.qualifies({**self.RES, "needsHumanReview": True}, 0.5, 0.4)
        assert not rollup.qualifies({**self.RES, "sourceClassification": "indeterminate"}, 0.5, 0.4)
        assert not rollup.qualifies({**self.RES, "crossValidation": {"agreementScore": 0.1}}, 0.5, 0.4)
        assert rollup.qualifies({**self.RES, "crossValidation": None}, 0.5, 0.4)

    def test_aggregate_counts_distinct_contributors(self, corridors):
        cell = geo.cell(28.63, 77.22)
        sub = lambda uid, t: {"h3Index": cell, "uploadedAt": t, "userId": uid, "geo": {"lat": 28.63, "lng": 77.22}}
        pairs = [(sub("u1", "2026-09-26T10:05:00.000Z"), self.RES), (sub("u1", "2026-09-26T10:40:00.000Z"), self.RES),
                 (sub("u2", "2026-09-26T10:59:00.000Z"), {**self.RES, "severityEstimate": 2})]
        [row] = rollup.aggregate(pairs, corridors, "now")
        assert row["report_count"] == 3 and row["contributor_count"] == 2
        assert row["avg_severity"] == pytest.approx(10 / 3)
        assert row["corridor_id"] == "ncr-airshed" and row["observation_hour"] == 10
