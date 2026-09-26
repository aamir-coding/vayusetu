import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError, ApiErrorCode } from '@vayusetu/shared-types';
import { ApiHttpError } from '../lib/errors.js';

function hasNumericStatusCode(value: unknown): value is { statusCode: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'statusCode' in value &&
    typeof (value as { statusCode: unknown }).statusCode === 'number'
  );
}

/** Week 1 mapped EVERY non-5xx status to VALIDATION_ERROR, so a rate-limited
 *  client got `429 VALIDATION_ERROR`. Map by status instead. */
const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN_JURISDICTION',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

/**
 * Every error response in this service, regardless of source, comes out
 * shaped as `ApiError` (@vayusetu/shared-types) -- the one envelope
 * API_CONTRACTS.md §4.2 mandates across all endpoints. Route handlers
 * should `throw new ApiHttpError(...)` and let this shape the reply.
 */
export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((rawError, request, reply) => {
    if (rawError instanceof ApiHttpError) {
      const body: ApiError = { error: { code: rawError.code, message: rawError.message, details: rawError.details } };
      reply.status(rawError.status).send(body);
      return;
    }

    if (rawError instanceof ZodError) {
      const body: ApiError = {
        error: { code: 'VALIDATION_ERROR', message: 'Request failed validation', details: rawError.flatten() },
      };
      reply.status(400).send(body);
      return;
    }

    const error = rawError instanceof Error ? rawError : new Error(String(rawError));
    const statusCode = hasNumericStatusCode(rawError) ? rawError.statusCode : 500;

    if (statusCode < 500) {
      const code = CODE_BY_STATUS[statusCode] ?? 'VALIDATION_ERROR';
      const body: ApiError = { error: { code, message: error.message } };
      reply.status(statusCode).send(body);
      return;
    }

    request.log.error({ err: error }, 'Unhandled error');
    const body: ApiError = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
    reply.status(500).send(body);
  });

  // Fastify's default 404 bypasses setErrorHandler entirely and returns its
  // own `{ message, error, statusCode }` shape.
  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = { error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` } };
    reply.status(404).send(body);
  });
});
