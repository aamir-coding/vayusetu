import { HttpResponse, http } from 'msw';
import type { Alert, AlertStatus, Jurisdiction, Paginated, ResourceRequest } from '@vayusetu/shared-types';
import {
  alerts as seedAlerts,
  corridors,
  federatedModels,
  forecastRuns,
  hotspotCells,
  mockSessionsByUid,
  resourceRequests as seedResourceRequests,
} from './fixtures';

const alertsStore = new Map(seedAlerts.map((a) => [a.id, a]));
const resourcesStore = new Map(seedResourceRequests.map((r) => [r.id, r]));

function extractSession(authHeader: string | null) {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  const uid = token.startsWith('mock-token:') ? token.slice('mock-token:'.length) : token;
  return mockSessionsByUid[uid] ?? null;
}

/** state_admin/super_admin (no districtCode) match on stateCode alone; district_admin needs an exact district match. */
function jurisdictionContains(caller: Jurisdiction, target: Jurisdiction): boolean {
  if (caller.stateCode !== target.stateCode) return false;
  if (caller.districtCode) return caller.districtCode === target.districtCode;
  return true;
}

const err = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });

// Conservative — mirrors the one example the contract gives (resolved -> new is invalid) plus dismissed being terminal.
const INVALID_TRANSITIONS: Partial<Record<AlertStatus, AlertStatus[]>> = {
  resolved: ['new'],
  dismissed: ['new', 'acknowledged', 'in_progress', 'resolved'],
};

export const handlers = [
  // ---------- Alerts ----------
  http.get('*/api/v1/alerts', ({ request }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as AlertStatus | null;
    const severity = url.searchParams.get('severity');
    const type = url.searchParams.get('type');

    let items = Array.from(alertsStore.values()).filter((a) => jurisdictionContains(session.jurisdiction, a.assignedJurisdiction));
    if (status) items = items.filter((a) => a.status === status);
    if (severity) items = items.filter((a) => a.severity === severity);
    if (type) items = items.filter((a) => a.type === type);
    items = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const body: Paginated<Alert> = { items, totalCount: items.length };
    return HttpResponse.json(body);
  }),

  http.get('*/api/v1/alerts/:id', ({ request, params }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    const alert = alertsStore.get(params.id as string);
    if (!alert) return err(404, 'NOT_FOUND', 'Alert not found');
    if (!jurisdictionContains(session.jurisdiction, alert.assignedJurisdiction)) {
      return err(403, 'FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }
    return HttpResponse.json(alert);
  }),

  http.patch('*/api/v1/alerts/:id/status', async ({ request, params }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    const alert = alertsStore.get(params.id as string);
    if (!alert) return err(404, 'NOT_FOUND', 'Alert not found');
    if (!jurisdictionContains(session.jurisdiction, alert.assignedJurisdiction)) {
      return err(403, 'FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }
    const { status, note } = (await request.json()) as { status: AlertStatus; note?: string };
    if (INVALID_TRANSITIONS[alert.status]?.includes(status)) {
      return err(409, 'CONFLICT', `Cannot move an alert from ${alert.status} to ${status}`);
    }
    const updated: Alert = {
      ...alert,
      status,
      statusHistory: [
        ...alert.statusHistory,
        { status, byUserId: session.jurisdiction.districtCode ?? session.jurisdiction.stateCode, at: new Date().toISOString(), note },
      ],
      updatedAt: new Date().toISOString(),
    };
    alertsStore.set(updated.id, updated);
    return HttpResponse.json(updated);
  }),

  http.post('*/api/v1/alerts/:id/assign', async ({ request, params }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    const alert = alertsStore.get(params.id as string);
    if (!alert) return err(404, 'NOT_FOUND', 'Alert not found');
    if (!jurisdictionContains(session.jurisdiction, alert.assignedJurisdiction)) {
      return err(403, 'FORBIDDEN_JURISDICTION', 'Outside your assigned jurisdiction');
    }
    const { officerId } = (await request.json()) as { officerId: string };
    const updated: Alert = { ...alert, assignedOfficerId: officerId, updatedAt: new Date().toISOString() };
    alertsStore.set(updated.id, updated);
    return HttpResponse.json(updated);
  }),

  // ---------- Hotspots ----------
  http.get('*/api/v1/hotspots', ({ request }) => {
    const url = new URL(request.url);
    const corridorId = url.searchParams.get('corridorId');
    if (!corridorId) return err(400, 'VALIDATION_ERROR', 'corridorId is required');
    const cells = hotspotCells.filter((c) => c.corridorId === corridorId);
    return HttpResponse.json({ cells });
  }),

  http.get('*/api/v1/hotspots/:h3Index/history', ({ params }) => {
    const h3Index = params.h3Index as string;
    const points = hotspotCells.filter((c) => c.h3Index === h3Index);
    return HttpResponse.json({ h3Index, points });
  }),

  // ---------- Forecasts ----------
  http.get('*/api/v1/forecasts/:corridorId/latest', ({ params }) => {
    const run = forecastRuns[params.corridorId as string];
    if (!run) return err(404, 'NOT_FOUND', 'No forecast for this corridor');
    return HttpResponse.json(run);
  }),

  http.get('*/api/v1/forecasts/:corridorId/history', ({ params }) => {
    const run = forecastRuns[params.corridorId as string];
    if (!run) return err(404, 'NOT_FOUND', 'No forecast for this corridor');
    return HttpResponse.json({ corridorId: params.corridorId, runs: [run] });
  }),

  // ---------- Resource Coordination ----------
  http.post('*/api/v1/resources/requests', async ({ request }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    const body = (await request.json()) as Pick<ResourceRequest, 'resourceType' | 'quantityNeeded' | 'relatedAlertId'>;
    const created: ResourceRequest = {
      id: `res-${Date.now()}`,
      jurisdiction: session.jurisdiction,
      resourceType: body.resourceType,
      quantityNeeded: body.quantityNeeded,
      relatedAlertId: body.relatedAlertId,
      status: 'open',
      createdBy: session.jurisdiction.districtCode ?? session.jurisdiction.stateCode,
      createdAt: new Date().toISOString(),
    };
    resourcesStore.set(created.id, created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.get('*/api/v1/resources/requests', ({ request }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    const items = Array.from(resourcesStore.values()).filter(
      (r) =>
        jurisdictionContains(session.jurisdiction, r.jurisdiction) ||
        (!session.jurisdiction.districtCode && r.jurisdiction.stateCode === session.jurisdiction.stateCode),
    );
    const body: Paginated<ResourceRequest> = { items, totalCount: items.length };
    return HttpResponse.json(body);
  }),

  // ---------- Federation ----------
  http.get('*/api/v1/federation/models', ({ request }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    if (session.role === 'district_admin') return err(403, 'FORBIDDEN_JURISDICTION', 'state_admin or above required');
    return HttpResponse.json({ available: federatedModels, currentlyActive: null });
  }),

  http.post('*/api/v1/federation/models/:modelId/import', ({ request }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    // Deliberately the highest bar in the system — no mock persona is
    // super_admin, so this 403s in mock mode exactly as it should for
    // Deshmukh or Iyer in production. That's the contract working, not a
    // bug in the mock.
    return err(403, 'FORBIDDEN_JURISDICTION', 'super_admin required to import a federated model');
  }),

  http.get('*/api/v1/federation/exchange/hotspot-summary', ({ request }) => {
    const session = extractSession(request.headers.get('authorization'));
    if (!session) return err(401, 'UNAUTHORIZED', 'Not signed in');
    if (session.role === 'district_admin') return err(403, 'FORBIDDEN_JURISDICTION', 'state_admin or above required');
    return HttpResponse.json({
      summary: [
        { sourceStateCode: 'HR', h3IndexGeneralized: '861fb4657ffffff', weekStartDate: '2026-08-24', avgHotspotConfidence: 0.68 },
        { sourceStateCode: 'UP', h3IndexGeneralized: '861fb46cfffffff', weekStartDate: '2026-08-24', avgHotspotConfidence: 0.54 },
      ],
    });
  }),

  // ---------- Corridors ----------
  http.get('*/api/v1/corridors', () => HttpResponse.json({ corridors })),
  http.get('*/api/v1/corridors/:id', ({ params }) => {
    const corridor = corridors.find((c) => c.id === params.id);
    if (!corridor) return err(404, 'NOT_FOUND', 'Corridor not found');
    return HttpResponse.json(corridor);
  }),
];
