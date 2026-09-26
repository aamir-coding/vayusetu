import { OAuth2Client } from 'google-auth-library';
import type { FastifyRequest } from 'fastify';
import { ApiHttpError } from '../lib/errors.js';

export interface OidcClaims {
  email?: string;
  email_verified?: boolean;
}

export type IdTokenVerifier = (idToken: string, audience: string) => Promise<OidcClaims>;

const googleVerifier = (): IdTokenVerifier => {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return ticket.getPayload() ?? {};
  };
};

/**
 * Authenticates Pub/Sub push deliveries. The Cloud Run service is public
 * (Week 1 cloud_run.tf), so without this ANYONE could POST a fake
 * hotspot.updated and trigger alerts + SMS to officials.
 *
 * Pub/Sub signs each push with an OIDC token for the push service account
 * (infra/terraform pubsub.tf). We verify: Google signature + expiry, the
 * audience we configured, and the exact SA email. Checking signature alone
 * is not enough -- any Google-signed token for any SA would pass.
 */
export function createPushAuthHook(cfg: {
  mode: 'oidc' | 'off';
  audience?: string;
  serviceAccountEmail?: string;
  verify?: IdTokenVerifier;
}) {
  const verify = cfg.verify ?? (cfg.mode === 'oidc' ? googleVerifier() : undefined);

  return async function pushAuth(request: FastifyRequest): Promise<void> {
    if (cfg.mode === 'off') return;

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiHttpError('UNAUTHORIZED', 'Missing push OIDC token');

    let claims: OidcClaims;
    try {
      claims = await verify!(header.slice('Bearer '.length), cfg.audience!);
    } catch (error) {
      request.log.warn({ err: error }, 'Pub/Sub push token failed verification');
      throw new ApiHttpError('UNAUTHORIZED', 'Invalid push OIDC token');
    }

    if (claims.email !== cfg.serviceAccountEmail || claims.email_verified !== true) {
      request.log.warn({ email: claims.email }, 'Pub/Sub push token from unexpected service account');
      throw new ApiHttpError('UNAUTHORIZED', 'Push token not issued for the expected service account');
    }
  };
}
