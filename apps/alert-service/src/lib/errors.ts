import type { ApiErrorCode } from '@vayusetu/shared-types';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN_JURISDICTION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/**
 * Every route throws this instead of manually shaping a response --
 * `plugins/errorHandler.ts` is the single place that turns it into the
 * `ApiError` envelope API_CONTRACTS.md §4.2 mandates for every endpoint.
 */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiHttpError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
