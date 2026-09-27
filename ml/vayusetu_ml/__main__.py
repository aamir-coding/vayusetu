"""python -m vayusetu_ml <command>

  specs                      print specs.json (read by hotspot-/forecast-service)
  build   hotspot|forecast   build the training table only (inspect before paying for AutoML)
  compile hotspot|forecast   compile the KFP pipeline to ml/build/<kind>_pipeline.yaml
  run     hotspot|forecast   compile + submit to Vertex AI Pipelines
  schedule hotspot|forecast  create a monthly Vertex AI Pipelines schedule

Env: GOOGLE_CLOUD_PROJECT, VERTEX_LOCATION (asia-south1), BQ_DATASET (core),
PIPELINE_ROOT (gs://<project>-model-artifacts/pipelines),
PIPELINE_SA (ml-pipelines-<env>@...), STATE_CODE (DL), TRAIN_DAYS (365),
BUDGET_MILLI_NODE_HOURS (1000 = 1 node hour, the AutoML minimum).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import specs, training_sql

BUILD = Path(__file__).resolve().parents[1] / "build"


def _env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise SystemExit(f"{name} is required")
    return value


def parameters(kind: str) -> dict:
    project = _env("GOOGLE_CLOUD_PROJECT")
    dataset = os.getenv("BQ_DATASET", "core")
    days = int(os.getenv("TRAIN_DAYS", "365"))
    if kind == "forecast":
        days = min(days, specs.FORECAST.max_train_days)  # AutoML 3000-step series cap
    window = training_sql.time_split_window(datetime.now(timezone.utc), days)
    spec = specs.HOTSPOT if kind == "hotspot" else specs.FORECAST
    common = {
        "project": project,
        "location": os.getenv("VERTEX_LOCATION", "asia-south1"),
        "sql": training_sql.render(kind, project, dataset),
        "table": f"{project}.{dataset}.{spec.training_table}",
        "start_ts": window.start,
        "end_ts": window.end,
        "validate_from": window.validate_from,
        "test_from": window.test_from,
        "display_name": spec.display_name,
        "target": spec.target,
        "split_column": spec.split_column,
        "optimization_objective": spec.optimization_objective,
        "budget_milli_node_hours": int(os.getenv("BUDGET_MILLI_NODE_HOURS", "1000")),
        # federation-service reads these (WEEK3_PART1.md proposal, now implemented)
        "labels": {
            "vayusetu-model-type": kind,
            "vayusetu-feature-schema": spec.feature_schema,
            "vayusetu-train-start": window.start[:10],
            "vayusetu-train-end": window.end[:10],
            "vayusetu-state": os.getenv("STATE_CODE", "DL").lower(),
        },
        "gate_metric": spec.gate_metric,
        "gate": spec.gate_min,
        "eval_table": f"{project}.{dataset}.model_evaluations",
    }
    if kind == "hotspot":
        return {**common, "numeric_features": list(specs.HOTSPOT.numeric_features),
                "categorical_features": list(specs.HOTSPOT.categorical_features)}
    f = specs.FORECAST
    return {**common, "time_column": f.time_column, "series_column": f.series_column,
            "available_at_forecast": list(f.available_at_forecast),
            "unavailable_at_forecast": list(f.unavailable_at_forecast),
            "attribute_columns": list(f.attribute_columns), "horizon_steps": f.horizon_steps,
            "context_steps": f.context_steps, "granularity_hours": f.granularity_hours,
            "quantiles": list(f.quantiles)}


def compile_pipeline(kind: str) -> Path:
    from kfp import compiler

    from . import pipelines

    BUILD.mkdir(exist_ok=True)
    out = BUILD / f"{kind}_pipeline.yaml"
    fn = pipelines.hotspot_pipeline if kind == "hotspot" else pipelines.forecast_pipeline
    compiler.Compiler().compile(pipeline_func=fn, package_path=str(out))
    return out


def submit(kind: str, schedule: bool = False) -> None:
    from google.cloud import aiplatform

    params = parameters(kind)
    project = params["project"]
    aiplatform.init(project=project, location=params["location"])
    job = aiplatform.PipelineJob(
        display_name=f"vayusetu-{kind}-retrain",
        template_path=str(compile_pipeline(kind)),
        pipeline_root=os.getenv("PIPELINE_ROOT", f"gs://{project}-model-artifacts/pipelines"),
        parameter_values=params,
        enable_caching=False,
    )
    sa = os.getenv("PIPELINE_SA")
    if schedule:
        # 1st of each month, 02:00 IST. The window slides because parameters are
        # computed at schedule creation -- re-create the schedule each quarter,
        # or trigger `run` from Cloud Scheduler for a truly sliding window.
        job.create_schedule(display_name=f"vayusetu-{kind}-monthly", cron="TZ=Asia/Kolkata 0 2 1 * *", service_account=sa)
        print(f"scheduled vayusetu-{kind}-monthly")
    else:
        job.submit(service_account=sa)
        print(f"submitted: {job.resource_name}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="vayusetu_ml")
    p.add_argument("command", choices=["specs", "build", "compile", "run", "schedule"])
    p.add_argument("kind", nargs="?", choices=["hotspot", "forecast"])
    a = p.parse_args(argv)
    if a.command == "specs":
        print(json.dumps(specs.as_json(), indent=2))
        return 0
    if not a.kind:
        p.error("kind is required")
    if a.command == "build":
        prm = parameters(a.kind)
        window = specs.TrainingWindow(prm["start_ts"], prm["end_ts"], prm["validate_from"], prm["test_from"])
        print(json.dumps(training_sql.build(a.kind, prm["project"], window, os.getenv("BQ_DATASET", "core")), default=str, indent=2))
    elif a.command == "compile":
        print(compile_pipeline(a.kind))
    else:
        submit(a.kind, schedule=a.command == "schedule")
    return 0


if __name__ == "__main__":
    sys.exit(main())
