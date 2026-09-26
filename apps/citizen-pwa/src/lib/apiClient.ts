import type {
  AnalysisResult,
  ApiError,
  BCP47LanguageTag,
  GeoPoint,
  Paginated,
  Submission,
  SubmissionStatus,
  User,
  UserRole,
} from '@vayusetu/shared-types';

/**
 * Thin typed wrapper around the REST surface documented in
 * `API_CONTRACTS.md` §4.2 — only the endpoints Feature 1 (Snap & Sense)
 * touches. Every shape here is imported from `@vayusetu/shared-types` or
 * copied verbatim from the contract's inline request bodies; nothing here
 * invents a field the contract doesn't have.
 *
 * Base URL defaults to a relative `/api/v1` (not an absolute localhost URL)
 * specifically so MSW's `*\/api/v1/...` wildcard handlers match in mock
 * mode regardless of dev-server origin.
 */
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
      // non-JSON error body — fall through to status text
    }
    throw new ApiClientError(
      res.status,
      body?.error?.code ?? 'INTERNAL_ERROR',
      body?.error?.message ?? res.statusText,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Worth queueing and retrying later: the network is down (fetch throws a
 * TypeError), the server is overloaded/rate-limiting, or it failed
 * transiently (5xx -- e.g. POST /submissions's "jurisdiction unresolvable,
 * retry"). Everything else (400/401/403/404/409) will fail again on retry,
 * so it is surfaced to the user instead of parked in the offline queue.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status >= 500 || status === 429 || status === 408);
}

// ===================== Users =====================

export interface RegisterUserRequest {
  displayName: string;
  preferredLanguage: BCP47LanguageTag;
  role: Extract<UserRole, 'citizen' | 'field_worker'>;
}

export const usersApi = {
  register: (token: string, body: RegisterUserRequest) =>
    request<User>('/users/register', token, { method: 'POST', body: JSON.stringify(body) }),

  me: (token: string) => request<User>('/users/me', token),

  update: (
    token: string,
    body: Partial<Pick<User, 'displayName' | 'preferredLanguage' | 'fcmTokens'>>,
  ) => request<User>('/users/me', token, { method: 'PATCH', body: JSON.stringify(body) }),
};

// ===================== Submissions =====================

export interface CreateSubmissionRequest {
  mediaType: Submission['mediaType'];
  photoStorageUrl: string;
  audioStorageUrl?: string;
  geo: GeoPoint;
  capturedAt: string;
  deviceMeta?: Submission['deviceMeta'];
  /** Field-worker-only, Product Spec Feature 1: optional PM2.5/PM10 sensor
   *  reading alongside the photo. Not present in API_CONTRACTS.md §4.1's
   *  Submission or the POST /submissions request body, so it is NOT sent
   *  to the server yet — flagging this to Engineer 2/3 as a probable
   *  contract gap rather than inventing a field. Kept client-side only
   *  (shown in the confirmation UI) until the contract is extended. */
  fieldSensorReading?: { pm25?: number; pm10?: number };
}

export interface UploadUrlResponse {
  uploadUrl: string;
  storageUrl: string;
  expiresAt: string;
}

export const submissionsApi = {
  uploadUrl: (token: string, body: { kind: 'photo' | 'audio'; contentType: string }) =>
    request<UploadUrlResponse>('/submissions/upload-url', token, { method: 'POST', body: JSON.stringify(body) }),

  create: (token: string, body: CreateSubmissionRequest) =>
    request<{ submission: Submission }>('/submissions', token, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  get: (token: string, id: string) =>
    request<{ submission: Submission; analysis: AnalysisResult | null }>(`/submissions/${id}`, token),

  list: (
    token: string,
    query: { userId?: string; status?: SubmissionStatus; pageSize?: number; pageToken?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (query.userId) qs.set('userId', query.userId);
    if (query.status) qs.set('status', query.status);
    if (query.pageSize) qs.set('pageSize', String(query.pageSize));
    if (query.pageToken) qs.set('pageToken', query.pageToken);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<Paginated<Submission>>(`/submissions${suffix}`, token);
  },

  retryAnalysis: (token: string, id: string) =>
    request<{ submission: Submission }>(`/submissions/${id}/retry-analysis`, token, { method: 'POST' }),
};

// ===================== Analysis =====================

export const analysisApi = {
  get: (token: string, submissionId: string) =>
    request<{ status: SubmissionStatus; result: AnalysisResult | null }>(
      `/analysis/${submissionId}`,
      token,
    ),
};
