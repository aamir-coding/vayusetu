"""Model specifications: the single place feature lists, targets and quality
gates live. SQL (ml/sql, data/schemas/features) produces these columns;
training components and the serving services (hotspot-service,
forecast-service) read them from here -- via the JSON dump `specs.json`
for the TypeScript side (see `python -m vayusetu_ml specs`).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

# Bumped whenever a feature is added/removed/redefined. federation-service
# refuses to import a model whose schema version this deployment can't serve
# (FEATURE_SCHEMA_VERSIONS=hotspot=hs-v1,forecast=fc-v2).
HOTSPOT_FEATURE_SCHEMA = "hs-v1"
FORECAST_FEATURE_SCHEMA = "fc-v2"  # v2: 3-hourly steps (AutoML 3000-step series cap)


@dataclass(frozen=True)
class HotspotSpec:
    display_name: str = "vayusetu-hotspot-confidence"
    feature_schema: str = HOTSPOT_FEATURE_SCHEMA
    training_table: str = "hotspot_training_dataset"
    target: str = "is_hotspot"
    positive_class: str = "hotspot"
    split_column: str = "split"
    numeric_features: tuple[str, ...] = (
        "sat_no2", "sat_aerosol_index", "sat_aod", "sat_fire_count", "sat_burn_scar",
        "wind_speed_ms", "wind_dir_sin", "wind_dir_cos", "temperature_c", "relative_humidity_pct", "precipitation_mm",
        "citizen_report_count_3h", "citizen_avg_severity_3h",
        "regional_aqi_d2", "regional_station_count_d2",
    )
    categorical_features: tuple[str, ...] = ("hour_ist", "day_of_week", "month", "is_harvest_season", "is_diwali_window")
    optimization_objective: str = "maximize-au-prc"  # positives are rare; AU-PRC is the honest metric
    # Quality gate on the TIME-held-out test split.
    gate_metric: str = "auPrc"
    gate_min: float = 0.30
    higher_is_better: bool = True

    @property
    def features(self) -> tuple[str, ...]:
        return self.numeric_features + self.categorical_features


@dataclass(frozen=True)
class ForecastSpec:
    display_name: str = "vayusetu-aqi-forecast"
    feature_schema: str = FORECAST_FEATURE_SCHEMA
    training_table: str = "forecast_training_dataset"
    target: str = "aqi"
    time_column: str = "ts"
    series_column: str = "station_id"
    split_column: str = "split"
    horizon_hours: int = 72   # PRODUCT_SPEC Feature 3
    context_hours: int = 168
    # AutoML Forecasting caps a series at 3000 time steps; a year of HOURLY
    # readings is 8760. At 3-hour steps a year is 2920 -- every season (the
    # winter smog season above all) stays in training. NAQI is a 24 h
    # average, so 3 h resolution loses nothing the 24/48/72 h outputs use.
    granularity_hours: int = 3
    max_series_steps: int = 3000
    quantiles: tuple[float, ...] = (0.1, 0.5, 0.9)
    available_at_forecast: tuple[str, ...] = (
        "wind_speed_ms", "wind_dir_sin", "wind_dir_cos", "temperature_c", "relative_humidity_pct", "precipitation_mm",
        "hour_ist", "day_of_week", "is_harvest_season", "is_diwali_window",
    )
    unavailable_at_forecast: tuple[str, ...] = (
        "aqi", "boundary_layer_height_m", "corridor_fire_count_d1", "corridor_mean_aod_d1",
    )
    attribute_columns: tuple[str, ...] = ("corridor_id",)
    optimization_objective: str = "minimize-quantile-loss"
    gate_metric: str = "meanAbsolutePercentageError"
    gate_min: float = 40.0  # MAPE % ceiling for promotion
    higher_is_better: bool = False

    @property
    def horizon_steps(self) -> int:
        return self.horizon_hours // self.granularity_hours

    @property
    def context_steps(self) -> int:
        return self.context_hours // self.granularity_hours

    @property
    def max_train_days(self) -> int:
        # Leave headroom for the horizon/context the service appends.
        return (self.max_series_steps * self.granularity_hours) // 24 - 5


HOTSPOT = HotspotSpec()
FORECAST = ForecastSpec()


def as_json() -> dict:
    h, f = asdict(HOTSPOT), asdict(FORECAST)
    h["features"] = list(HOTSPOT.features)
    return {"hotspot": h, "forecast": f}


@dataclass(frozen=True)
class TrainingWindow:
    start: str  # ISO timestamps
    end: str
    validate_from: str
    test_from: str
    extra: dict = field(default_factory=dict)
