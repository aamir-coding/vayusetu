import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

/**
 * Pub/Sub PUSH plumbing shared by every subscriber service (alert-service
 * has its own original copy; analysis/hotspot/forecast use this one).
 *
 * Ack protocol: the HTTP status IS the ack. 2xx = done (or permanently
 * undeliverable -- stop retrying); non-2xx = nack -> redelivery with backoff
 * -> dead-letter topic.
 */

export const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string().optional(),
    attributes: z.record(z.string()).optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
  deliveryAttempt: z.number().optional(),
});

export type DecodedPush<T> =
  | { ok: true; payload: T; messageId?: string; deliveryAttempt?: number }
  | { ok: false; reason: string; detail?: unknown };

/** Malformed envelope/payload never becomes valid -> callers ACK it (log + drop). */
export function decodePush<S extends z.ZodTypeAny>(body: unknown, schema: S): DecodedPush<z.infer<S>> {
  const envelope = PushEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { ok: false, reason: 'malformed envelope', detail: envelope.error.issues };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString('utf-8'));
  } catch {
    return { ok: false, reason: 'message.data is not base64 JSON' };
  }
  const payload = schema.safeParse(json);
  if (!payload.success) {
    return { ok: false, reason: 'payload violates API_CONTRACTS.md 4.3', detail: payload.error.issues };
  }
  return {
    ok: true,
    payload: payload.data,
    messageId: envelope.data.message.messageId,
    deliveryAttempt: envelope.data.deliveryAttempt,
  };
}

/** Thrown by an event handler when retrying can never succeed (referenced doc
 *  missing, ...): the route ACKs instead of nacking into the dead-letter topic. */
export class NonRetryableEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableEventError';
  }
}

export interface OidcClaims {
  email?: string;
  email_verified?: boolean;
}
export type IdTokenVerifier = (idToken: string, audience: string) => Promise<OidcClaims>;

export class PushAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushAuthError';
  }
}

/**
 * Verifies the OIDC token Pub/Sub signs each push with: Google signature +
 * expiry, the configured audience AND the exact push service account. A
 * signature check alone would accept any Google-signed token for any SA.
 * mode 'off' is for the local emulator only (it sends no token).
 */
export function createPushVerifier(cfg: {
  mode: 'oidc' | 'off';
  audience?: string;
  serviceAccountEmail?: string;
  verify?: IdTokenVerifier;
}): (authorizationHeader: string | undefined) => Promise<void> {
  if (cfg.mode === 'oidc' && (!cfg.audience || !cfg.serviceAccountEmail)) {
    throw new Error('PUBSUB_PUSH_AUDIENCE and PUBSUB_PUSH_SA_EMAIL are required when PUBSUB_PUSH_AUTH=oidc');
  }
  const client = cfg.verify ? undefined : new OAuth2Client();
  const verify: IdTokenVerifier =
    cfg.verify ??
    (async (idToken, audience) => (await client!.verifyIdToken({ idToken, audience })).getPayload() ?? {});

  return async (header) => {
    if (cfg.mode === 'off') return;
    if (!header?.startsWith('Bearer ')) throw new PushAuthError('Missing push OIDC token');
    let claims: OidcClaims;
    try {
      claims = await verify(header.slice('Bearer '.length), cfg.audience!);
    } catch {
      throw new PushAuthError('Invalid push OIDC token');
    }
    if (claims.email !== cfg.serviceAccountEmail || claims.email_verified !== true) {
      throw new PushAuthError('Push token not issued for the expected service account');
    }
  };
}
