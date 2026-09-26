import type { FastifyInstance } from 'fastify';
import type { Query } from 'firebase-admin/firestore';
import { z } from 'zod';
import type { Paginated, ResourceRequest } from '@vayusetu/shared-types';
import { alertsCollection, resourceRequestsCollection } from '../lib/collections.js';
import { jurisdictionContains } from '../lib/jurisdiction.js';
import { requireAuthUser } from '../plugins/auth.js';
import { ApiHttpError } from '../lib/errors.js';
import { decodePageToken, encodePageToken, requireOfficial } from '../lib/scope.js';

const RESOURCE_TYPES = [
  'inspection_team',
  'anti_smog_gun',
  'water_sprinkler',
  'mobile_monitoring_van',
  'public_advisory',
  'other',
] as const;

const CreateSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES),
  quantityNeeded: z.number().int().min(1).max(1000),
  relatedAlertId: z.string().min(1).max(200).optional(),
});

const ListQuerySchema = z.object({
  status: z.enum(['open', 'fulfilled', 'cancelled']).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  pageToken: z.string().optional(),
});

/**
 * Resource Coordination (Feature 4's Resource Coordination Board).
 * API_CONTRACTS.md 4.2: the requester's jurisdiction always comes from their
 * own profile, never the client. Visibility: district_admin -> own district,
 * state_admin -> whole state, super_admin -> all states (the cross-state view).
 */
export default async function resourcesRoutes(app: FastifyInstance) {
  app.post('/resources/requests', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { user, scope } = await requireOfficial(uid);
    const body = CreateSchema.parse(request.body);
    if (scope === 'all') {
      // A super_admin has no jurisdiction of their own to request resources FOR.
      throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'Resource requests are raised by a district or state official');
    }

    if (body.relatedAlertId) {
      const alert = await alertsCollection().doc(body.relatedAlertId).get();
      if (!alert.exists) throw new ApiHttpError('VALIDATION_ERROR', 'relatedAlertId does not exist');
      if (!jurisdictionContains(scope, alert.data()!.assignedJurisdiction)) {
        throw new ApiHttpError('FORBIDDEN_JURISDICTION', 'That alert is outside your jurisdiction');
      }
    }

    const ref = resourceRequestsCollection().doc();
    const created: ResourceRequest = {
      id: ref.id,
      jurisdiction: user.jurisdiction!,
      resourceType: body.resourceType,
      quantityNeeded: body.quantityNeeded,
      ...(body.relatedAlertId ? { relatedAlertId: body.relatedAlertId } : {}),
      status: 'open',
      createdBy: uid,
      createdAt: new Date().toISOString(),
    };
    await ref.set(created);
    reply.status(201).send(created);
  });

  app.get('/resources/requests', async (request, reply) => {
    const { uid } = requireAuthUser(request);
    const { scope } = await requireOfficial(uid);
    const query = ListQuerySchema.parse(request.query);

    let q: Query<ResourceRequest> = resourceRequestsCollection();
    if (scope !== 'all') {
      q = q.where('jurisdiction.stateCode', '==', scope.stateCode);
      if (scope.districtCode) q = q.where('jurisdiction.districtCode', '==', scope.districtCode);
    }
    if (query.status) q = q.where('status', '==', query.status);

    const totalCount = (await q.count().get()).data().count;
    let page = q.orderBy('createdAt', 'desc').limit(query.pageSize);
    if (query.pageToken) {
      const cursor = await resourceRequestsCollection().doc(decodePageToken(query.pageToken)).get();
      if (!cursor.exists) throw new ApiHttpError('VALIDATION_ERROR', 'pageToken refers to a deleted item');
      page = page.startAfter(cursor);
    }
    const snap = await page.get();
    const items = snap.docs.map((d) => d.data());
    const body: Paginated<ResourceRequest> = {
      items,
      totalCount,
      ...(items.length === query.pageSize ? { nextPageToken: encodePageToken(snap.docs.at(-1)!.id) } : {}),
    };
    reply.send(body);
  });
}
