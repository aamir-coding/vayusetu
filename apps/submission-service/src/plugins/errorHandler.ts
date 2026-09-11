import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError } from '@vayusetu/shared-types';
import { ApiHttpError } from '../lib/errors.js';

/**
 * Every error response in this service, regardless of source, comes out
 * shaped as `ApiError` (@vayusetu/shared-types) -- the one envelope
 * API_CONTRACTS.md §4.2 mandates across all 23 endpoints. Route handlers
 * should almost always just `throw new ApiHttpError(...)` and let this
 * catch it, rather than shaping a reply.send() themselves.
 */
function hasNumericStatusCode(value: unknown): value is { statusCode: number } {
  return typeof value === 'object' && value !== null && 'statusCode' in value && typeof (value as { statusCode: unknown }).statusCode === 'number';
}

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

    // Normalize once so every branch below has a real Error to read
    // .message off of, regardless of exactly how Fastify's error-handler
    // typing resolves `rawError` for a given plugin/route combination.
    const error = rawError instanceof Error ? rawError : new Error(String(rawError));

    // Fastify's own parsing/validation errors (e.g. malformed JSON body)
    // carry a `statusCode`; anything else falls through to 500.
    const statusCode = hasNumericStatusCode(rawError) ? rawError.statusCode : 500;
    if (statusCode < 500) {
      const body: ApiError = { error: { code: 'VALIDATION_ERROR', message: error.message } };
      reply.status(statusCode).send(body);
      return;
    }

    request.log.error({ err: error }, 'Unhandled error');
    const body: ApiError = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
    reply.status(500).send(body);
  });
});
