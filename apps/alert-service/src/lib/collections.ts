import { getDb } from '@vayusetu/gcp-clients';
import type { CollectionReference } from 'firebase-admin/firestore';
import type { Alert, Corridor, ForecastRun, HotspotCell, User } from '@vayusetu/shared-types';

/** Compile-time hints only (plain casts, not .withConverter()) -- same Week 1
 *  trade-off as submission-service/src/lib/collections.ts. */
export const usersCollection = () => getDb().collection('users') as CollectionReference<User>;
export const alertsCollection = () => getDb().collection('alerts') as CollectionReference<Alert>;
export const hotspotsCollection = () => getDb().collection('hotspots') as CollectionReference<HotspotCell>;
export const forecastsCollection = () => getDb().collection('forecasts') as CollectionReference<ForecastRun>;
export const corridorsCollection = () => getDb().collection('corridors') as CollectionReference<Corridor>;
