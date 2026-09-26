"""Vertex AI Pipelines (KFP v2) retrain DAGs for both models.

  build training table (BigQuery) -> AutoML training (new version under the
  same registry model, federation labels) -> evaluate on the time-held-out
  TEST split -> promote to alias `default` only if it clears the quality gate
  AND beats the current default -> record the evaluation in BigQuery.

Components are self-contained (Vertex runs each in its own container), so
everything they need arrives as parameters; `run.py` fills those from
specs.py and ml/sql at submit time.
"""

# NB: no `from __future__ import annotations` -- KFP reads real type objects
# from component signatures; stringified annotations fail to compile.

from kfp import dsl

AIPLATFORM = "google-cloud-aiplatform==2.2.0"
BIGQUERY = "google-cloud-bigquery==3.45.2"
BASE = "python:3.11-slim"


@dsl.component(base_image=BASE, packages_to_install=[BIGQUERY])
def build_training_table(project: str, location: str, sql: str, table: str, label_sql: str,
                         start_ts: str, end_ts: str, validate_from: str, test_from: str) -> dict:
    from google.cloud import bigquery

    client = bigquery.Client(project=project, location=location)
    params = [bigquery.ScalarQueryParameter(n, "TIMESTAMP", v) for n, v in
              (("start_ts", start_ts), ("end_ts", end_ts), ("validate_from", validate_from), ("test_from", test_from))]
    client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    row = list(client.query(
        f"SELECT COUNT(*) AS rows, COUNTIF({label_sql}) AS positives, COUNTIF(split = 'TEST') AS test FROM `{table}`"
    ).result())[0]
    if row["rows"] < 1000:
        raise RuntimeError(f"{table} has only {row['rows']} rows -- backfill more history before training")
    return {"rows": int(row["rows"]), "positives": int(row["positives"]), "test": int(row["test"])}


@dsl.component(base_image=BASE, packages_to_install=[AIPLATFORM])
def train_hotspot_model(project: str, location: str, table: str, display_name: str, target: str,
                        numeric_features: list, categorical_features: list, split_column: str,
                        optimization_objective: str, budget_milli_node_hours: int, labels: dict,
                        stats: dict) -> str:
    from google.cloud import aiplatform

    aiplatform.init(project=project, location=location)
    dataset = aiplatform.TabularDataset.create(display_name=f"{display_name}-data", bq_source=f"bq://{table}")
    specs = {c: "numeric" for c in numeric_features} | {c: "categorical" for c in categorical_features}
    job = aiplatform.AutoMLTabularTrainingJob(
        display_name=f"{display_name}-train",
        optimization_prediction_type="classification",
        optimization_objective=optimization_objective,
        column_specs=specs,
    )
    parents = aiplatform.Model.list(filter=f'display_name="{display_name}"')
    model = job.run(
        dataset=dataset,
        target_column=target,
        predefined_split_column_name=split_column,
        budget_milli_node_hours=budget_milli_node_hours,
        model_display_name=display_name,
        parent_model=parents[0].resource_name if parents else None,
        is_default_version=not parents,
        model_labels={**labels, "vayusetu-train-rows": str(stats["rows"])},
    )
    return model.versioned_resource_name


@dsl.component(base_image=BASE, packages_to_install=[AIPLATFORM])
def train_forecast_model(project: str, location: str, table: str, display_name: str, target: str,
                         time_column: str, series_column: str, available_at_forecast: list,
                         unavailable_at_forecast: list, attribute_columns: list, split_column: str,
                         horizon_hours: int, context_hours: int, quantiles: list,
                         optimization_objective: str, budget_milli_node_hours: int, labels: dict,
                         stats: dict) -> str:
    from google.cloud import aiplatform

    aiplatform.init(project=project, location=location)
    dataset = aiplatform.TimeSeriesDataset.create(display_name=f"{display_name}-data", bq_source=f"bq://{table}")
    job = aiplatform.AutoMLForecastingTrainingJob(
        display_name=f"{display_name}-train",
        optimization_objective=optimization_objective,
        column_specs={c: "auto" for c in [*available_at_forecast, *unavailable_at_forecast, *attribute_columns, time_column]},
    )
    parents = aiplatform.Model.list(filter=f'display_name="{display_name}"')
    model = job.run(
        dataset=dataset,
        target_column=target,
        time_column=time_column,
        time_series_identifier_column=series_column,
        available_at_forecast_columns=[time_column, *available_at_forecast],
        unavailable_at_forecast_columns=list(unavailable_at_forecast),
        time_series_attribute_columns=list(attribute_columns),
        forecast_horizon=horizon_hours,
        context_window=context_hours,
        data_granularity_unit="hour",
        data_granularity_count=1,
        predefined_split_column_name=split_column,
        quantiles=[float(q) for q in quantiles],
        holiday_regions=["IN"],
        budget_milli_node_hours=budget_milli_node_hours,
        model_display_name=display_name,
        parent_model=parents[0].resource_name if parents else None,
        is_default_version=not parents,
        model_labels={**labels, "vayusetu-train-rows": str(stats["rows"])},
    )
    return model.versioned_resource_name


@dsl.component(base_image=BASE, packages_to_install=[AIPLATFORM, BIGQUERY])
def evaluate_and_promote(project: str, location: str, model_version: str, model_type: str,
                         metric: str, gate: float, higher_is_better: bool, eval_table: str, stats: dict) -> str:
    """Promote to alias `default` iff the TEST-split metric clears the gate AND
    beats the current default. Records every evaluation (promoted or not)."""
    import datetime
    import json

    from google.cloud import aiplatform, bigquery

    aiplatform.init(project=project, location=location)
    candidate = aiplatform.Model(model_version)
    metrics = candidate.list_model_evaluations()[0].to_dict().get("metrics", {})
    value = metrics.get(metric)
    better = (lambda a, b: a > b) if higher_is_better else (lambda a, b: a < b)
    passes_gate = value is not None and (value >= gate if higher_is_better else value <= gate)

    current_value = None
    registry = aiplatform.models.ModelRegistry(candidate.resource_name.split("@")[0])
    for v in registry.list_versions():
        if "default" in (v.version_aliases or []) and v.version_id != candidate.version_id:
            current = aiplatform.Model(f"{candidate.resource_name.split('@')[0]}@{v.version_id}")
            evals = current.list_model_evaluations()
            current_value = evals[0].to_dict().get("metrics", {}).get(metric) if evals else None
    beats_current = current_value is None or (value is not None and better(value, current_value))
    decision = "promoted" if passes_gate and beats_current else "rejected"
    if decision == "promoted":
        registry.add_version_aliases(["default"], version=candidate.version_id)

    bigquery.Client(project=project, location=location).insert_rows_json(eval_table, [{
        "model_type": model_type,
        "model_version": model_version,
        "metric": metric,
        "value": value,
        "previous_default_value": current_value,
        "decision": decision,
        "all_metrics": json.dumps({k: v for k, v in metrics.items() if isinstance(v, (int, float))}),
        "training_rows": stats.get("rows"),
        "training_positives": stats.get("positives"),
        "evaluated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }])
    return decision


@dsl.pipeline(name="vayusetu-hotspot-retrain")
def hotspot_pipeline(project: str, location: str, sql: str, table: str, start_ts: str, end_ts: str,
                     validate_from: str, test_from: str, display_name: str, target: str,
                     numeric_features: list, categorical_features: list, split_column: str,
                     optimization_objective: str, budget_milli_node_hours: int, labels: dict,
                     gate_metric: str, gate: float, eval_table: str):
    stats = build_training_table(project=project, location=location, sql=sql, table=table,
                                 label_sql="is_hotspot = 'hotspot'", start_ts=start_ts, end_ts=end_ts,
                                 validate_from=validate_from, test_from=test_from)
    version = train_hotspot_model(project=project, location=location, table=table, display_name=display_name,
                                  target=target, numeric_features=numeric_features,
                                  categorical_features=categorical_features, split_column=split_column,
                                  optimization_objective=optimization_objective,
                                  budget_milli_node_hours=budget_milli_node_hours, labels=labels, stats=stats.output)
    evaluate_and_promote(project=project, location=location, model_version=version.output, model_type="hotspot",
                         metric=gate_metric, gate=gate, higher_is_better=True, eval_table=eval_table, stats=stats.output)


@dsl.pipeline(name="vayusetu-forecast-retrain")
def forecast_pipeline(project: str, location: str, sql: str, table: str, start_ts: str, end_ts: str,
                      validate_from: str, test_from: str, display_name: str, target: str, time_column: str,
                      series_column: str, available_at_forecast: list, unavailable_at_forecast: list,
                      attribute_columns: list, split_column: str, horizon_hours: int, context_hours: int,
                      quantiles: list, optimization_objective: str, budget_milli_node_hours: int, labels: dict,
                      gate_metric: str, gate: float, eval_table: str):
    stats = build_training_table(project=project, location=location, sql=sql, table=table, label_sql="FALSE",
                                 start_ts=start_ts, end_ts=end_ts, validate_from=validate_from, test_from=test_from)
    version = train_forecast_model(project=project, location=location, table=table, display_name=display_name,
                                   target=target, time_column=time_column, series_column=series_column,
                                   available_at_forecast=available_at_forecast,
                                   unavailable_at_forecast=unavailable_at_forecast,
                                   attribute_columns=attribute_columns, split_column=split_column,
                                   horizon_hours=horizon_hours, context_hours=context_hours, quantiles=quantiles,
                                   optimization_objective=optimization_objective,
                                   budget_milli_node_hours=budget_milli_node_hours, labels=labels, stats=stats.output)
    evaluate_and_promote(project=project, location=location, model_version=version.output, model_type="forecast",
                         metric=gate_metric, gate=gate, higher_is_better=False, eval_table=eval_table, stats=stats.output)
