# Build from the REPO ROOT (the image needs data/seed + data/schemas):
#   docker build -f apps/ingestion-jobs/Dockerfile -t ingestion-jobs .
# One image, many Cloud Run Jobs: each job passes its subcommand as args,
# e.g. ["cpcb"], ["weather", "--mode", "forecast"].
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VAYUSETU_DATA_DIR=/app/data

WORKDIR /app
COPY apps/ingestion-jobs/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY data/seed ./data/seed
COPY data/schemas ./data/schemas
COPY apps/ingestion-jobs/vayusetu_ingest ./vayusetu_ingest

USER 65532
ENTRYPOINT ["python", "-m", "vayusetu_ingest"]
