import type { FastifyInstance } from 'fastify';
import { cellToLatLng } from 'h3-js';
import { z } from 'zod';
import { getDb } from '@vayusetu/gcp-clients';
import type { HotspotCell } from '@vayusetu/shared-types';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';
import type { DataAdapters } from '../adapters/data.js';
import { TtlCache } from '../lib/ttlCache.js';

const BBox = z
  .string()
  .transform((s) => s.split(',').map(Number))
  .refine((a) => a.length === 4 && a.every(Number.isFinite), 'bbox must be minLat,minLng,maxLat,maxLng')
  .refine(([minLat, minLng, maxLat, maxLng]) => minLat! < maxLat! && minLng! < maxLng!, 'bbox min must be below max');

const ListQuery = z.object({
  corridorId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  bbox: BBox.optional(),
  sinceHour: z.string().datetime({ offset: true }).optional(),
});

const HistoryQuery = z.object({ range: z.enum(['24h', '7d', '30d']).default('7d') });
const RANGE_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
const H3 = /^[0-9a-f]{15}$/i;

/**
 * History is read from BigQuery core.hotspot_cells, which ONLY the hourly
 * scoring job writes (the citizen fast path writes Firestore, which the live
 * map reads). So a cell's history can change at most once an hour, and
 * caching it for 5 min costs at most 5 min of lag after that job. Each call
 * was two BigQuery queries, ~1.1 s p95 server-side and the only endpoint over
 * the 1.5 s bar in the 29 Sep load tests. The grid itself never changes.
 */
export const HISTORY_TTL_MS = 5 * 60_000;
export const CELL_EXISTS_TTL_MS = 24 * 3_600_000;

/** Firestore docs carry non-contract helpers (modelScore, expireAt) -- strip them from responses. */
function toContract(d: Record<string, unknown>): HotspotCell {
  const { modelScore: _m, expireAt: _e, ...cell } = d;
  void _m;
  void _e;
  return cell as unknown as HotspotCell;
}

/**
 * How far back the live map looks for the newest hourly grid. The job scores
 * the PREVIOUS hour at :40, so it trails the fast path by up to ~2h40m.
 */
export const LIVE_WINDOW_MS = 6 * 3_600_000;

/** Fast-path docs (a citizen report fused onto the model score), not the hourly job's grid. */
const isFastPath = (d: Record<string, unknown>) => {
  const v = String(d.modelVersion ?? '');
  return v === 'citizen-evidence' || v.endsWith('+citizen');
};

/**
 * The live heatmap: the newest hourly grid, overlaid with any NEWER fast-path
 * cells, one (the newest) doc per cell. The fast path writes the current hour
 * while the job has only scored the previous one, so "newest hour only" used
 * to shrink the map to just the freshly reported cells after every report.
 * Input must be sorted by timestampHour DESC.
 */
export function liveGrid(docs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const gridHour = docs.find((d) => !isFastPath(d))?.timestampHour as string | undefined;
  const byCell = new Map<string, Record<string, unknown>>();
  for (const d of docs) {
    if (gridHour && (d.timestampHour as string) < gridHour) break;
    const h = d.h3Index as string;
    if (!byCell.has(h)) byCell.set(h, d);
  }
  return [...byCell.values()];
}

export function inBBox(h3Index: string, [minLat, minLng, maxLat, maxLng]: number[]): boolean {
  const [lat, lng] = cellToLatLng(h3Index);
  return lat >= minLat! && lat <= maxLat! && lng >= minLng! && lng <= maxLng!;
}

export default async function hotspotsRoutes(app: FastifyInstance, opts: { data: DataAdapters; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const cellExists = new TtlCache<boolean>(CELL_EXISTS_TTL_MS, 50_000, now);
  const history = new TtlCache<HotspotCell[]>(HISTORY_TTL_MS, 2_000, now);

  // GET /hotspots?corridorId=&bbox=&sinceHour= -- API_CONTRACTS.md 4.2.
  // Without sinceHour: the live heatmap (liveGrid: newest hourly grid + newer citizen fast-path cells).
  app.get('/hotspots', async (request, reply) => {
    requireAuthUser(request);
    const q = ListQuery.parse(request.query);
    const col = getDb().collection('hotspots');
    let docs: Array<Record<string, unknown>>;
    if (q.sinceHour) {
      const since = new Date(q.sinceHour).toISOString();
      docs = (await col.where('corridorId', '==', q.corridorId).where('timestampHour', '>=', since).orderBy('timestampHour', 'desc').limit(5000).get())
        .docs.map((d) => d.data());
    } else {
      const latest = (await col.where('corridorId', '==', q.corridorId).orderBy('timestampHour', 'desc').limit(1).get()).docs[0];
      const hour = latest?.data().timestampHour as string | undefined;
      const since = hour ? new Date(new Date(hour).getTime() - LIVE_WINDOW_MS).toISOString() : undefined;
      docs = since
        ? liveGrid((await col.where('corridorId', '==', q.corridorId).where('timestampHour', '>=', since).orderBy('timestampHour', 'desc').limit(5000).get()).docs.map((d) => d.data()))
        : [];
    }
    let cells = docs.map(toContract);
    if (q.bbox) cells = cells.filter((c) => inBBox(c.h3Index, q.bbox!));
    cells.sort((a, b) => b.hotspotConfidenceScore - a.hotspotConfidenceScore);
    reply.send({ cells });
  });

  // GET /hotspots/:h3Index/history?range=24h|7d|30d -- the full hourly grid (BigQuery).
  app.get('/hotspots/:h3Index/history', async (request, reply) => {
    requireAuthUser(request);
    const { h3Index } = request.params as { h3Index: string };
    const { range } = HistoryQuery.parse(request.query);
    const cell = h3Index.toLowerCase();
    if (!H3.test(cell) || !(await cellExists.get(cell, () => opts.data.cellExists(cell)))) {
      throw new ApiHttpError('NOT_FOUND', 'Unknown H3 cell (not in any corridor grid)');
    }
    const points = await history.get(`${cell}|${range}`, () =>
      opts.data.history(cell, new Date(now() - RANGE_MS[range]).toISOString()),
    );
    reply.send({ h3Index, points });
  });
}
