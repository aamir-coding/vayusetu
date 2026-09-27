import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from vayusetu_ml import specs, training_sql

REPO = Path(__file__).resolve().parents[2]
FEATURES_TVF = (REPO / "data/schemas/features/hotspot_features.sql").read_text(encoding="utf-8")


def test_training_sql_renders_fully():
    for kind in ("hotspot", "forecast"):
        sql = training_sql.render(kind, "proj")
        assert "{dataset}" not in sql
        assert f"`proj.core.{kind}_training_dataset`" in sql
        for param in ("@start_ts", "@end_ts"):
            assert param in sql
    # Forecasting is evaluated on the most recent period (chronological tail).
    assert "@test_from" in training_sql.render("forecast", "proj")


def test_hotspot_split_is_week_blocked_across_seasons():
    # A chronological tail put the whole TEST set in the monsoon (3.8% vs 19%
    # positives). Whole weeks, spread over the year, instead.
    sql = training_sql.render("hotspot", "p")
    assert "MOD(DIV(UNIX_DATE(DATE(f.ts)), 7), 7)" in sql
    assert ">= @test_from" not in sql


def test_hotspot_features_exist_in_the_shared_tvf():
    # Every model feature must be produced by the ONE function scoring also uses.
    for col in specs.HOTSPOT.features:
        assert re.search(rf"\bAS {col}\b|\bm\.{col}\b|\bg\.{col}\b", FEATURES_TVF) or f" {col}," in FEATURES_TVF, col


def test_hotspot_training_drops_proximity_columns_and_labels():
    sql = training_sql.render("hotspot", "p")
    assert "EXCEPT (has_monitor_within_radius, nearest_station_id, nearest_station_distance_km, nearest_station_aqi_d2)" in sql
    assert "IF(sh.aqi >= 201 AND sh.aqi - rn.aqi >= 50, 'hotspot', 'normal') AS is_hotspot" in sql
    assert specs.HOTSPOT.positive_class == "hotspot"
    assert "boundary_layer_height" not in " ".join(specs.HOTSPOT.features)  # ERA5 lags ~5 days: never live


def test_forecast_columns_exist_in_training_sql():
    sql = training_sql.render("forecast", "p")
    f = specs.FORECAST
    for col in (*f.available_at_forecast, *f.unavailable_at_forecast, *f.attribute_columns, f.series_column, f.time_column):
        assert re.search(rf"\b{col}\b", sql), col
    assert f.target in f.unavailable_at_forecast
    assert f.horizon_hours == 72  # PRODUCT_SPEC Feature 3


def test_forecast_fits_automl_limits():
    # AutoML Forecasting: series <= 3000 steps (1st run: 8078 hourly steps)
    # and granularity 1 hour or 1 day only (2nd run rejected 3-hourly).
    f = specs.FORECAST
    assert f.granularity_unit == "day"
    assert (f.horizon_steps, f.context_steps) == (3, 14)  # +24/+48/+72 h
    assert f.max_train_days >= 365 and f.max_train_days + f.context_steps + f.horizon_steps <= f.max_series_steps
    assert "hour_ist" not in f.available_at_forecast
    sql = training_sql.render("forecast", "p")
    scoring = (REPO / "data/schemas/features/forecast_input.sql").read_text(encoding="utf-8")
    ist_day = "TIMESTAMP(DATE(ts, 'Asia/Kolkata'), 'Asia/Kolkata')"
    assert ist_day in sql and "HAVING COUNT(*) >= 16" in sql  # CPCB 24 h completeness
    assert "TIMESTAMP(d, 'Asia/Kolkata') AS ts" in scoring and "INTERVAL 3 DAY" in scoring
    assert "hour_ist" not in scoring


def test_hotspot_training_allows_missing_numeric_values():
    import inspect
    from vayusetu_ml import pipelines
    src = inspect.getsource(pipelines.train_hotspot_model.python_func)
    assert '"invalid_values_allowed": True' in src


def test_time_split_is_chronological():
    w = training_sql.time_split_window(datetime(2026, 9, 26, 17, 42, tzinfo=timezone.utc), 100)
    assert w.start < w.validate_from < w.test_from < w.end
    assert w.end == "2026-09-26T17:00:00+00:00"
    assert w.test_from == "2026-09-11T17:00:00+00:00"  # last 15 of 100 days


def test_specs_json_is_serializable():
    data = json.loads(json.dumps(specs.as_json()))
    assert data["hotspot"]["feature_schema"] == "hs-v1" and data["forecast"]["feature_schema"] == "fc-v2"
    assert data["hotspot"]["features"] == list(specs.HOTSPOT.features)


@pytest.mark.parametrize("kind", ["hotspot", "forecast"])
def test_pipelines_compile_offline(kind, tmp_path, monkeypatch):
    from vayusetu_ml import __main__ as cli

    monkeypatch.setattr(cli, "BUILD", tmp_path)
    out = cli.compile_pipeline(kind)
    import yaml

    spec = yaml.safe_load(out.read_text(encoding="utf-8"))
    tasks = spec["root"]["dag"]["tasks"]
    assert any("build-training-table" in t for t in tasks)
    assert any("evaluate-and-promote" in t for t in tasks)


@pytest.mark.parametrize("kind", ["hotspot", "forecast"])
def test_parameters_cover_every_pipeline_input(kind, monkeypatch):
    from vayusetu_ml import __main__ as cli
    from vayusetu_ml import pipelines

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "proj")
    params = cli.parameters(kind)
    fn = pipelines.hotspot_pipeline if kind == "hotspot" else pipelines.forecast_pipeline
    expected = set(fn.component_spec.inputs.keys())
    assert set(params) == expected
    assert params["labels"]["vayusetu-feature-schema"] in {"hs-v1", "fc-v2"}
    assert all(re.fullmatch(r"[a-z0-9_-]{1,63}", v) for v in params["labels"].values())


def test_forecast_scoring_input_matches_training_columns():
    # AutoML batch prediction matches input columns to the training schema:
    # core.forecast_input must produce every training column (bar split).
    scoring = (REPO / "data/schemas/features/forecast_input.sql").read_text(encoding="utf-8")
    f = specs.FORECAST
    for col in (*f.available_at_forecast, *f.unavailable_at_forecast, *f.attribute_columns, f.series_column, f.time_column):
        assert re.search(rf"\b{col}\b", scoring), col
