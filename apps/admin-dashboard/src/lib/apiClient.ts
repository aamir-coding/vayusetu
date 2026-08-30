import type {
  Alert,
  AlertSeverity,
  AlertStatus,
  AlertType,
  ApiError,
  Corridor,
  CorridorId,
  FederatedModel,
  ForecastRun,
  H3Index,
  HotspotCell,
  Paginated,
  ResourceRequest,
  ResourceType,
} from '@vayusetu/shared-types';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: ApiError['error']['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: ApiError | undefined;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // non-JSON error body
    }
    throw new ApiClientError(res.status, body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ===================== Alerts =====================

export const alertsApi = {
  list: (
    token: string,
    query: { status?: AlertStatus; severity?: AlertSeverity; type?: AlertType; pageSize?: number; pageToken?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (query.status) qs.set('status', query.status);
    if (query.severity) qs.set('severity', query.severity);
    if (query.type) qs.set('type', query.type);
    if (query.pageSize) qs.set('pageSize', String(query.pageSize));
    if (query.pageToken) qs.set('pageToken', query.pageToken);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<Paginated<Alert>>(`/alerts${suffix}`, token);
  },

  get: (token: string, id: string) => request<Alert>(`/alerts/${id}`, token),

  updateStatus: (token: string, id: string, body: { status: AlertStatus; note?: string }) =>
    request<Alert>(`/alerts/${id}/status`, token, { method: 'PATCH', body: JSON.stringify(body) }),

  assign: (token: string, id: string, officerId: string) =>
    request<Alert>(`/alerts/${id}/assign`, token, { method: 'POST', body: JSON.stringify({ officerId }) }),
};

// ===================== Hotspots =====================

export const hotspotsApi = {
  list: (token: string, corridorId: CorridorId, query: { bbox?: string; sinceHour?: string } = {}) => {
    const qs = new URLSearchParams({ corridorId });
    if (query.bbox) qs.set('bbox', query.bbox);
    if (query.sinceHour) qs.set('sinceHour', query.sinceHour);
    return request<{ cells: HotspotCell[] }>(`/hotspots?${qs.toString()}`, token);
  },

  history: (token: string, h3Index: H3Index, range: '24h' | '7d' | '30d' = '7d') =>
    request<{ h3Index: H3Index; points: HotspotCell[] }>(`/hotspots/${h3Index}/history?range=${range}`, token),
};

// ===================== Forecasts =====================

export const forecastsApi = {
  latest: (token: string, corridorId: CorridorId) => request<ForecastRun>(`/forecasts/${corridorId}/latest`, token),

  history: (token: string, corridorId: CorridorId, range: '7d' | '30d' | '90d' = '7d') =>
    request<{ corridorId: CorridorId; runs: ForecastRun[] }>(`/forecasts/${corridorId}/history?range=${range}`, token),
};

// ===================== Resource Coordination =====================

export const resourcesApi = {
  create: (token: string, body: { resourceType: ResourceType; quantityNeeded: number; relatedAlertId?: string }) =>
    request<ResourceRequest>('/resources/requests', token, { method: 'POST', body: JSON.stringify(body) }),

  list: (token: string, query: { status?: ResourceRequest['status']; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (query.status) qs.set('status', query.status);
    if (query.pageSize) qs.set('pageSize', String(query.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<Paginated<ResourceRequest>>(`/resources/requests${suffix}`, token);
  },
};

// ===================== Federation =====================

export const federationApi = {
  models: (token: string, type?: FederatedModel['modelType']) =>
    request<{ available: FederatedModel[]; currentlyActive: FederatedModel | null }>(
      `/federation/models${type ? `?type=${type}` : ''}`,
      token,
    ),

  importModel: (token: string, modelId: string) =>
    request<{ imported: FederatedModel; activatedAt: string }>(`/federation/models/${modelId}/import`, token, {
      method: 'POST',
    }),

  hotspotSummary: (token: string, bbox: string) =>
    request<{
      summary: Array<{ sourceStateCode: string; h3IndexGeneralized: H3Index; weekStartDate: string; avgHotspotConfidence: number }>;
    }>(`/federation/exchange/hotspot-summary?bbox=${bbox}`, token),
};

// ===================== Corridors =====================

export const corridorsApi = {
  list: (token: string) => request<{ corridors: Corridor[] }>('/corridors', token),
  get: (token: string, id: CorridorId) => request<Corridor>(`/corridors/${id}`, token),
};
