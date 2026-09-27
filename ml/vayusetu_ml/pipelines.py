"""Vertex AI Pipelines (KFP v2) retrain DAGs for both models.

  build training table (BigQuery) -> AutoML training (new version under the
  same registry model, federation labels) -> evaluate on the held-out
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
        f"SELECT COUNT(*) AS `rows`, COUNTIF({label_sql}) AS positives, COUNTIF(split = 'TEST') AS test FROM `{table}`"
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
    # invalid_values_allowed: missing values are data here (cloud-covered
    # satellite pixels, hours with no citizen report) -- AutoML learns a
    # "missing" indicator. Without it every row with ANY null numeric is
    # discarded; citizen_avg_severity_3h is null on every historical row, so
    # the first run rejected all 540k rows ("0 were valid").
    transformations = [{"numeric": {"column_name": c, "invalid_values_allowed": True}} for c in numeric_features] + [
        {"categorical": {"column_name": c}} for c in categorical_features
    ]
    job = aiplatform.AutoMLTabularTrainingJob(
        display_name=f"{display_name}-train",
        optimization_prediction_type="classification",
        optimization_objective=optimization_objective,
        column_transformations=transformations,
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
                         horizon_steps: int, context_steps: int, granularity_unit: str, quantiles: list,
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
        forecast_horizon=horizon_steps,   # steps of granularity_unit (Vertex: 1 hour or 1 day, no multiples)
        context_window=context_steps,
        data_granularity_unit=granularity_unit,
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
                         metric: str, gate: float, higher_is_better: bool, eval_table: str, stats: dict,
                         positive_class: str = "") -> str:
    """Gate on the TEST-split metric, label the version with the outcome, and
    move alias `default` to it only if it passes AND beats the current default.
    Records every evaluation (promoted or not).

    - Classification: the gate reads the POSITIVE class's slice. Vertex's
      top-level auPrc is micro-averaged over both classes, so the 85%
      "normal" class inflated it (first live model: 0.895 overall vs 0.292
      for `hotspot`) and a failing model was promoted.
    - The label `vayusetu-gate=passed|failed` is the source of truth for
      "promoted": a model's FIRST version always receives `default` at
      training time, so the alias alone cannot mean "passed". federation-
      service only publishes versions labelled `passed`.
    """
    import datetime
    import json

    from google.cloud import aiplatform, bigquery
    from google.cloud.aiplatform_v1 import ModelServiceClient

    aiplatform.init(project=project, location=location)
    candidate = aiplatform.Model(model_version)
    evaluation = candidate.list_model_evaluations()[0]
    metrics = evaluation.to_dict().get("metrics", {})

    def positive_slice(resource_name: str, label: str) -> dict:
        client = ModelServiceClient(client_options={"api_endpoint": f"{location}-aiplatform.googleapis.com"})
        for s in client.list_model_evaluation_slices(parent=resource_name):
            if s.slice_.dimension == "annotationSpec" and s.slice_.value == label:
                return dict(s.metrics)
        return {}

    def slice_metric(resource_name: str, label: str):
        return positive_slice(resource_name, label).get(metric)

    # Classifiers: the confidence threshold with the best F1 on the TEST
    # split -- hotspot-service's HIDDEN_MIN_CONFIDENCE is set from it when the
    # model goes live (a fixed 0.6 on a 15%-base-rate model flags ~nothing).
    best_threshold = None
    if positive_class:
        curve = [dict(c) for c in positive_slice(evaluation.resource_name, positive_class).get("confidenceMetrics", [])]
        scored = [c for c in curve if c.get("f1Score") is not None and 0 < c.get("confidenceThreshold", 0) < 1]
        if scored:
            best = max(scored, key=lambda c: c["f1Score"])
            best_threshold = {"threshold": best["confidenceThreshold"], "f1": best["f1Score"],
                              "precision": best.get("precision"), "recall": best.get("recall")}

    value = slice_metric(evaluation.resource_name, positive_class) if positive_class else metrics.get(metric)
    better = (lambda a, b: a > b) if higher_is_better else (lambda a, b: a < b)
    passes_gate = value is not None and (value >= gate if higher_is_better else value <= gate)

    current_value = None
    registry = aiplatform.models.ModelRegistry(candidate.resource_name.split("@")[0])
    for v in registry.list_versions():
        if "default" in (v.version_aliases or []) and v.version_id != candidate.version_id:
            current = aiplatform.Model(f"{candidate.resource_name.split('@')[0]}@{v.version_id}")
            if (current.labels or {}).get("vayusetu-gate") != "passed":
                continue  # a failed version holding `default` (first version) is no bar to beat
            evals = current.list_model_evaluations()
            if evals:
                current_value = (slice_metric(evals[0].resource_name, positive_class) if positive_class
                                 else evals[0].to_dict().get("metrics", {}).get(metric))
    beats_current = current_value is None or (value is not None and better(value, current_value))
    decision = "promoted" if passes_gate and beats_current else "rejected"
    # Label THIS version. The SDK's Model.update() always writes the
    # UNVERSIONED name -- i.e. whichever version holds `default` -- so it
    # labelled the PREVIOUS version (live: v2's passed/0.5503 landed on v1).
    # UpdateModel on the versioned name with a labels mask edits only this one.
    from google.cloud.aiplatform_v1.types import Model as ModelProto
    from google.protobuf import field_mask_pb2

    labels = {
        **(candidate.labels or {}),
        "vayusetu-gate": "passed" if decision == "promoted" else "failed",
        "vayusetu-gate-metric": metric.lower()[:63],
        "vayusetu-gate-value": ("na" if value is None else f"{value:.4f}".replace(".", "_")),
        **({"vayusetu-threshold": f"{best_threshold['threshold']:.3f}".replace(".", "_")} if best_threshold else {}),
    }
    ModelServiceClient(client_options={"api_endpoint": f"{location}-aiplatform.googleapis.com"}).update_model(
        model=ModelProto(name=candidate.versioned_resource_name, labels=labels),
        update_mask=field_mask_pb2.FieldMask(paths=["labels"]),
    )
    if decision == "promoted":
        registry.add_version_aliases(["default"], version=candidate.version_id)

    bigquery.Client(project=project, location=location).insert_rows_json(eval_table, [{
        "model_type": model_type,
        "model_version": model_version,
        "metric": metric,
        "value": value,
        "previous_default_value": current_value,
        "decision": decision,
        "all_metrics": json.dumps({**{k: v for k, v in metrics.items() if isinstance(v, (int, float))},
                                   **({f"gate_{metric}": value} if positive_class else {}),
                                   **({"best_f1_threshold": best_threshold} if best_threshold else {})}),
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
                         metric=gate_metric, gate=gate, higher_is_better=True, eval_table=eval_table, stats=stats.output, positive_class="hotspot")


@dsl.pipeline(name="vayusetu-forecast-retrain")
def forecast_pipeline(project: str, location: str, sql: str, table: str, start_ts: str, end_ts: str,
                      validate_from: str, test_from: str, display_name: str, target: str, time_column: str,
                      series_column: str, available_at_forecast: list, unavailable_at_forecast: list,
                      attribute_columns: list, split_column: str, horizon_steps: int, context_steps: int, granularity_unit: str,
                      quantiles: list, optimization_objective: str, budget_milli_node_hours: int, labels: dict,
                      gate_metric: str, gate: float, eval_table: str):
    stats = build_training_table(project=project, location=location, sql=sql, table=table, label_sql="FALSE",
                                 start_ts=start_ts, end_ts=end_ts, validate_from=validate_from, test_from=test_from)
    version = train_forecast_model(project=project, location=location, table=table, display_name=display_name,
                                   target=target, time_column=time_column, series_column=series_column,
                                   available_at_forecast=available_at_forecast,
                                   unavailable_at_forecast=unavailable_at_forecast,
                                   attribute_columns=attribute_columns, split_column=split_column,
                                   horizon_steps=horizon_steps, context_steps=context_steps, granularity_unit=granularity_unit, quantiles=quantiles,
                                   optimization_objective=optimization_objective,
                                   budget_milli_node_hours=budget_milli_node_hours, labels=labels, stats=stats.output)
    evaluate_and_promote(project=project, location=location, model_version=version.output, model_type="forecast",
                         metric=gate_metric, gate=gate, higher_is_better=False, eval_table=eval_table, stats=stats.output)
