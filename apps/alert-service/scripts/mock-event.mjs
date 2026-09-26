// Stands in for Engineer 3's hotspot-service / forecast-service until they
// publish real events ("initially mocked" -- Week 2 scope). Follows the same
// rule they must: WRITE THE DOCUMENT FIRST, then publish the thin event
// (API_CONTRACTS.md §4.3 -- alert-service re-reads the doc).
//
//   node scripts/mock-event.mjs hotspot  [--score 0.92] [--lat 28.6329 --lng 77.2195] [--hidden] [--direct]
//   node scripts/mock-event.mjs forecast [--aqi 420] [--corridor ncr-airshed] [--direct]
//
// --direct  POSTs a push envelope straight to alert-service instead of
//           publishing (use if emulator push delivery misbehaves; needs
//           PUBSUB_PUSH_AUTH=off on the service).
// Against a REAL project (no emulator hosts set) it requires --yes.
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PubSub } from '@google-cloud/pubsub';
import { latLngToCell } from 'h3-js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    score: { type: 'string', default: '0.92' },
    lat: { type: 'string', default: '28.6329' },
    lng: { type: 'string', default: '77.2195' },
    hidden: { type: 'boolean', default: false },
    aqi: { type: 'string', default: '420' },
    corridor: { type: 'string', default: 'ncr-airshed' },
    direct: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});
const kind = positionals[0];
if (kind !== 'hotspot' && kind !== 'forecast') {
  console.error('Usage: mock-event.mjs hotspot|forecast [options] -- see header comment');
  process.exit(1);
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'vayusetu-ncr-dev';
const usingEmulators = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
if (!usingEmulators && !values.yes) {
  console.error(`No FIRESTORE_EMULATOR_HOST: this would write a MOCK ${kind} into REAL project "${projectId}". Re-run with --yes.`);
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();
const now = new Date();
const hour = now.toISOString().slice(0, 13); // e.g. 2026-09-24T06

let topic, payload;
if (kind === 'hotspot') {
  const h3Index = latLngToCell(Number(values.lat), Number(values.lng), 8);
  const score = Number(values.score);
  const cell = {
    id: `${h3Index}_${hour}`, h3Index, corridorId: 'ncr-airshed', timestampHour: `${hour}:00:00.000Z`,
    hotspotConfidenceScore: score, isHidden: values.hidden, classification: 'open_waste_burning',
    contributingSignals: { citizenReportCount: 7, avgCitizenSeverity: 4.1, satelliteAOD: 0.61, fireDetectionCount: 2 },
    modelVersion: 'mock-event-script', createdAt: now.toISOString(),
  };
  await db.collection('hotspots').doc(cell.id).set(cell);
  topic = 'hotspot.updated';
  payload = { hotspotCellId: cell.id, corridorId: cell.corridorId, hotspotConfidenceScore: score };
} else {
  const aqi = Number(values.aqi);
  const id = `${values.corridor}_${now.toISOString()}`;
  const point = (h, v) => ({
    horizonHours: h, predictedAQI: v,
    predictedAQICategory: v > 400 ? 'severe' : v > 300 ? 'very_poor' : v > 200 ? 'poor' : 'moderate',
    predictedGRAPStage: 'none', confidenceInterval: { lower: v - 25, upper: v + 25 },
  });
  const run = {
    id, corridorId: values.corridor, forecastRunTimestamp: now.toISOString(),
    horizons: [point(24, Math.round(aqi * 0.8)), point(48, aqi), point(72, Math.round(aqi * 0.9))],
    keyDrivers: ['declining boundary-layer height', 'upwind stubble-fire counts rising'],
    modelVersion: 'mock-event-script', createdAt: now.toISOString(),
  };
  await db.collection('forecasts').doc(id).set(run);
  topic = 'forecast.updated';
  payload = { forecastRunId: id, corridorId: values.corridor, maxHorizonAQI: aqi };
}
console.log(`Wrote ${kind} doc; payload:`, payload);

if (values.direct) {
  const base = (process.env.ALERT_SERVICE_URL ?? 'http://localhost:8082').replace(/\/$/, '');
  const path = kind === 'hotspot' ? '/pubsub/hotspot-updated' : '/pubsub/forecast-updated';
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId: `direct-${Date.now()}` } }),
  });
  console.log(`POST ${path} -> ${res.status} (204 = processed/acked, 500 = would be retried)`);
} else {
  const messageId = await new PubSub({ projectId }).topic(topic).publishMessage({ json: payload });
  console.log(`Published ${topic} (messageId ${messageId}). Watch alert-service logs.`);
}
