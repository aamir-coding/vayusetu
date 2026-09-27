import h3
import pytest

from vayusetu_ingest import aqi, geo
from vayusetu_ingest.bq import dedupe, merge_sql
from vayusetu_ingest.config import OPERATIONAL_H3_RES


class TestAqi:
    @pytest.mark.parametrize("value,expected", [
        (0, "good"), (50, "good"), (51, "satisfactory"), (200, "moderate"),
        (201, "poor"), (350, "very_poor"), (401, "severe"), (650, "severe"), (None, None),
    ])
    def test_category_bands(self, value, expected):
        assert aqi.category(value) == expected

    def test_pm25_sub_index_matches_cpcb_breakpoints(self):
        assert aqi.sub_index("PM2.5", 30) == 50
        assert aqi.sub_index("PM2.5", 60) == 100
        assert aqi.sub_index("PM2.5", 250) == 400
        assert aqi.sub_index("PM2.5", 45.5) == 76  # 51 + 49 * (45.5-31)/29

    def test_co_uses_mg_per_m3(self):
        assert aqi.sub_index("CO", 2.0) == 100

    def test_station_aqi_is_max_sub_index(self):
        assert aqi.station_aqi({"PM2.5": 180, "NO2": 60, "CO": 40}) == 180

    def test_station_aqi_needs_three_pollutants_including_pm(self):
        assert aqi.station_aqi({"PM2.5": 180, "NO2": 60}) is None
        assert aqi.station_aqi({"NO2": 60, "CO": 40, "SO2": 10}) is None
        assert aqi.station_aqi({"PM10": 90, "NO2": 60, "CO": None, "SO2": 10}) == 90

    def test_pollutant_aliases(self):
        assert aqi.normalize_pollutant("OZONE") == "OZONE"
        assert aqi.normalize_pollutant("pm25") == "PM2.5"
        assert aqi.normalize_pollutant("Pb") is None


class TestGeo:
    def test_operational_resolution_is_8(self):
        # The Week-2 CPCB/IMD jobs wrote res 7; every h3 join then matched nothing.
        assert h3.get_resolution(geo.cell(28.6315, 77.2167)) == OPERATIONAL_H3_RES == 8

    def test_corridor_ids_match_the_api_contract(self):
        ids = {c.id for c in geo.load_corridors()}
        assert ids == {"ncr-airshed", "mumbai-pune-corridor"}

    def test_corridor_contains(self):
        ncr, mh = geo.load_corridors()
        assert ncr.contains(28.6139, 77.2090)  # New Delhi
        assert not ncr.contains(19.076, 72.8777)
        assert mh.contains(19.076, 72.8777)  # Mumbai
        assert geo.corridor_for(18.5204, 73.8567, [ncr, mh]).id == "mumbai-pune-corridor"  # Pune

    def test_corridor_states_are_state_codes(self):
        for c in geo.load_corridors():
            assert all(len(s) == 2 and s.isupper() for s in c.states)

    def test_haversine(self):
        assert geo.haversine_km(28.6139, 77.2090, 19.0760, 72.8777) == pytest.approx(1150, rel=0.02)


class TestMerge:
    def test_merge_sql_is_null_safe_and_hashable(self):
        sql = merge_sql("p.core.t", "p.core.t__stg", ["h3_index", "observation_hour"], ["h3_index", "observation_hour", "v"],
                        nullable_keys=["observation_hour"])
        assert "T.`h3_index` = S.`h3_index`" in sql
        assert "COALESCE(CAST(T.`observation_hour` AS STRING)" in sql
        assert "IS NOT DISTINCT FROM" not in sql  # defeats the hash join (CPU-limit failure at 50k rows)
        assert "UPDATE SET `v` = S.`v`" in sql
        assert "INSERT (`h3_index`, `observation_hour`, `v`)" in sql

    def test_merge_sql_prunes_partitions(self):
        sql = merge_sql("p.core.t", "p.core.s", ["observation_date"], ["observation_date", "v"],
                        prune=("observation_date", "2026-01-01", "2026-01-31"))
        assert "T.`observation_date` BETWEEN '2026-01-01' AND '2026-01-31'" in sql

    def test_dedupe_last_wins(self):
        rows = [{"k": 1, "v": "a"}, {"k": 1, "v": "b"}, {"k": 2, "v": "c"}]
        assert sorted(r["v"] for r in dedupe(rows, ["k"])) == ["b", "c"]


def test_data_dir_env_wins_without_touching_the_repo_path(monkeypatch, tmp_path):
    # Regression: in the container config.py lives at /app/vayusetu_ingest/,
    # which has no parents[3]; the default must not be computed when the env is set.
    import vayusetu_ingest.config as config

    monkeypatch.setenv("VAYUSETU_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "__file__", "/app/vayusetu_ingest/config.py")
    assert config._data_dir() == tmp_path
