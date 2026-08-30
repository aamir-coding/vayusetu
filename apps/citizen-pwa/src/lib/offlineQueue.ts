import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { GeoPoint, Submission } from '@vayusetu/shared-types';

/**
 * Workbox (via vite-plugin-pwa) handles *asset* offline caching and the
 * install/update lifecycle. It does not, by itself, know how to replay a
 * multi-megabyte photo submission once connectivity returns. This module
 * is the pragmatic Week 1 scope for that half of "offline-capable": queue
 * the full submission (including the photo/audio blobs) in IndexedDB, and
 * flush it from the app when `navigator.onLine` flips true and a tab is
 * open. True Background Sync (flushing from the service worker with no
 * tab open) is real, valuable, browser-support-variable work — noted as a
 * Phase 1.5 follow-up rather than silently left out.
 */

export interface QueuedSubmission {
  localId: string;
  mediaType: Submission['mediaType'];
  photoBlob: Blob;
  audioBlob?: Blob;
  geo: GeoPoint;
  capturedAt: string;
  fieldSensorReading?: { pm25?: number; pm10?: number };
  queuedAt: string;
}

interface QueueDB extends DBSchema {
  pending: {
    key: string;
    value: QueuedSubmission;
  };
}

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<QueueDB>('vayusetu-offline-queue', 1, {
      upgrade(db) {
        db.createObjectStore('pending', { keyPath: 'localId' });
      },
    });
  }
  return dbPromise;
}

export async function enqueueSubmission(item: Omit<QueuedSubmission, 'localId' | 'queuedAt'>): Promise<QueuedSubmission> {
  const db = await getDb();
  const queued: QueuedSubmission = {
    ...item,
    localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: new Date().toISOString(),
  };
  await db.put('pending', queued);
  return queued;
}

export async function listQueuedSubmissions(): Promise<QueuedSubmission[]> {
  const db = await getDb();
  const all = await db.getAll('pending');
  return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function removeQueuedSubmission(localId: string): Promise<void> {
  const db = await getDb();
  await db.delete('pending', localId);
}

export async function countQueuedSubmissions(): Promise<number> {
  const db = await getDb();
  return db.count('pending');
}
