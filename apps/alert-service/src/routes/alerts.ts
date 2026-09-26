import type { FastifyInstance } from 'fastify';
import type { Query } from 'firebase-admin/firestore';
import { z } from 'zod';
import { getDb } from '@vayusetu/gcp-clients';
import type { Alert, Paginated } from '@vayusetu/shared-types';
import { alertsCollection, usersCollection } from '../lib/collections.js';
import { ApiHttpError } from '../lib/errors.js';
import { jurisdictionContains } from '../lib/jurisdiction.js';
import { type OfficialCaller, requireOfficial } from '../plugins/auth.js';
import { checkTransition } from '../domain/transitions.js';

const STATUSES = ['new', 'acknowledged', 'in_progress', 'resolved', 'dismissed'] as const;

const ListQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  severity: z.enum(['info', 'watch', 'warning', 'critical']).optional(),
  type: z.enum(['hotspot', 'forecast']).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  pageToken: z.string().optional(),
});

const StatusBodySchema = z.object({
  status: z.enum(STATUSES),
  note: z.string().trim().max(1000).optional(),
});

const AssignBodySchema = z.object({ officerId: z.string().min(1) });

function canAccess(caller: OfficialCaller, alert: Alert): boolean {
  return caller.scope === 'all' || jurisdictionContains(caller.scope, alert.assignedJurisdiction);
}

async function loadAccessibleAlert(caller: OfficialCaller, id: string): Promise<Alert> {
  const snap = await alertsCollection().doc(id).get();
  if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Alert not found');
  const alert = snap.data()!;
  if (!canAccess(caller, alert)) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
  return alert;
}

const encodeToken = (id: string) => Buffer.from(id, 'utf-8').toString('base64url');
function decodeToken(token: string): string {
  const id = Buffer.from(token, 'base64url').toString('utf-8');
  if (!id || id.length > 400 || id.includes('/')) throw new ApiHttpError('VALIDATION_ERROR', 'Invalid pageToken');
  return id;
}

export default async function alertsRoutes(app: FastifyInstance) {
  /**
   * Jurisdiction filtering happens in the QUERY, server-side (contract:
   * "never client-filtered"). Sorted by createdAt desc, NOT severity: the
   * severity string sorts critical LAST lexicographically (see
   * domain/severity.ts). Index strategy: one (field, createdAt DESC) index per
   * filterable field, which Firestore merges for any filter combination --
   * see infra/terraform firestore.tf.
   */
  app.get('/alerts', async (request, reply) => {
    const caller = await requireOfficial(request);
    const query = ListQuerySchema.parse(request.query);

    let q: Query<Alert> = alertsCollection();
    if (caller.scope !== 'all') {
      q = q.where('assignedJurisdiction.stateCode', '==', caller.scope.stateCode);
      if (caller.scope.districtCode) q = q.where('assignedJurisdiction.districtCode', '==', caller.scope.districtCode);
    }
    if (query.status) q = q.where('status', '==', query.status);
    if (query.severity) q = q.where('severity', '==', query.severity);
    if (query.type) q = q.where('type', '==', query.type);

    const totalCount = (await q.count().get()).data().count;

    let page = q.orderBy('createdAt', 'desc').limit(query.pageSize);
    if (query.pageToken) {
      const cursor = await alertsCollection().doc(decodeToken(query.pageToken)).get();
      if (!cursor.exists) throw new ApiHttpError('VALIDATION_ERROR', 'pageToken refers to a deleted item');
      page = page.startAfter(cursor);
    }

    const snap = await page.get();
    const items = snap.docs.map((d) => d.data());
    const body: Paginated<Alert> = {
      items,
      totalCount,
      ...(items.length === query.pageSize ? { nextPageToken: encodeToken(snap.docs.at(-1)!.id) } : {}),
    };
    reply.send(body);
  });

  app.get('/alerts/:id', async (request, reply) => {
    const caller = await requireOfficial(request);
    const { id } = request.params as { id: string };
    reply.send(await loadAccessibleAlert(caller, id));
  });

  /**
   * Transactional read-check-append: two officials acting at once can't lose
   * a statusHistory entry, and the transition is checked against the state
   * actually being written over. update() on named fields only, so a
   * concurrent notificationsSent write from the pipeline isn't clobbered.
   */
  app.patch('/alerts/:id/status', async (request, reply) => {
    const caller = await requireOfficial(request);
    const { id } = request.params as { id: string };
    const body = StatusBodySchema.parse(request.body);
    const ref = alertsCollection().doc(id);

    const updated = await getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'Alert not found');
      const alert = snap.data()!;
      if (!canAccess(caller, alert)) throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');

      const verdict = checkTransition(alert.status, body.status);
      if (verdict === 'invalid') {
        throw new ApiHttpError('CONFLICT', `Invalid status transition: ${alert.status} -> ${body.status}`, {
          from: alert.status,
          to: body.status,
        });
      }
      if (verdict === 'noop') return alert;

      const at = new Date().toISOString();
      const entry = { status: body.status, byUserId: caller.uid, at, ...(body.note ? { note: body.note } : {}) };
      const changes = { status: body.status, statusHistory: [...alert.statusHistory, entry], updatedAt: at };
      tx.update(ref, changes);
      return { ...alert, ...changes };
    });

    reply.send(updated);
  });

  /**
   * CONTRACT NOTE: API_CONTRACTS.md lists only 401/403/404 for this endpoint,
   * but a missing/ineligible officerId is a client input error, so it's 400
   * VALIDATION_ERROR -- flagged in WEEK2_SETUP.md to add 400 to the contract.
   */
  app.post('/alerts/:id/assign', async (request, reply) => {
    const caller = await requireOfficial(request);
    const { id } = request.params as { id: string };
    const { officerId } = AssignBodySchema.parse(request.body);

    const alert = await loadAccessibleAlert(caller, id);

    const officerSnap = await usersCollection().doc(officerId).get();
    const officer = officerSnap.exists ? officerSnap.data()! : undefined;
    const eligible =
      officer &&
      (officer.role === 'district_admin' || officer.role === 'state_admin') &&
      officer.jurisdiction &&
      jurisdictionContains(officer.jurisdiction, alert.assignedJurisdiction);
    if (!eligible) {
      throw new ApiHttpError('VALIDATION_ERROR', 'officerId must be an official whose jurisdiction covers this alert');
    }

    const at = new Date().toISOString();
    await alertsCollection().doc(id).update({ assignedOfficerId: officerId, updatedAt: at });
    reply.send({ ...alert, assignedOfficerId: officerId, updatedAt: at });
  });
}
