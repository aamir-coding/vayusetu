#!/usr/bin/env bash
# Starts the Firestore + Pub/Sub emulators for local backend development.
# Prereqs (one-time):
#   gcloud components install cloud-firestore-emulator pubsub-emulator
#
# Usage: ./infra/scripts/dev-emulators.sh
# Leave this running in its own terminal; Ctrl+C stops both emulators.
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-vayusetu-ncr-dev}"

echo "Starting Firestore emulator on :8081 and Pub/Sub emulator on :8085 (project=$PROJECT_ID)"
echo "Ctrl+C stops both."

gcloud emulators firestore start --host-port=localhost:8081 --project="$PROJECT_ID" &
FIRESTORE_PID=$!

gcloud beta emulators pubsub start --host-port=localhost:8085 --project="$PROJECT_ID" &
PUBSUB_PID=$!

trap 'kill "$FIRESTORE_PID" "$PUBSUB_PID" 2>/dev/null' EXIT
wait
