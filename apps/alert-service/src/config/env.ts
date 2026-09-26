import { z } from 'zod';

const thresholdsTriple = z
  .string()
  .transform((s) => s.split(',').map((n) => Number(n.trim())))
  .refine((a) => a.length === 3 && a.every((n) => n > 0 && n <= 1) && a[0]! < a[1]! && a[1]! < a[2]!, {
    message: 'must be three increasing numbers in (0,1], e.g. "0.6,0.75,0.9" (watch,warning,critical)',
  });

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8082),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    DEFAULT_STATE_CODE: z.string().default('DL'),
    DEFAULT_DISTRICT_CODE: z.string().default('DL-CENTRAL'),
    CORS_ORIGIN: z.string().default('*'),

    // Officials' REST auth. mock accepts the admin dashboard's
    // `mock-token:<uid>` scheme (mock-deshmukh / mock-iyer).
    AUTH_MODE: z.enum(['firebase', 'mock']).default('firebase'),

    // Pub/Sub push auth. 'oidc' verifies the Google-signed token Pub/Sub
    // attaches to every push. 'off' is for the local emulator, which sends none.
    PUBSUB_PUSH_AUTH: z.enum(['oidc', 'off']).default('oidc'),
    PUBSUB_PUSH_AUDIENCE: z.string().optional(),
    PUBSUB_PUSH_SA_EMAIL: z.string().email().optional(),

    // FCM has no emulator; 'stub' logs instead of sending (local dev).
    PUSH_CHANNEL_MODE: z.enum(['live', 'stub']).default('live'),
    // Partner SMS/WhatsApp gateways are stubbed for Week 2 by design.
    SMS_CHANNEL_MODE: z.enum(['stub', 'disabled']).default('stub'),
    WHATSAPP_CHANNEL_MODE: z.enum(['stub', 'disabled']).default('stub'),

    DASHBOARD_BASE_URL: z.string().url().default('http://localhost:5174'),

    // Severity thresholds on HotspotCell.hotspotConfidenceScore. NOT in any
    // contract doc -- "a configured severity threshold" is all AI_PIPELINES.md
    // says. Defaults are placeholders until Engineer 3 knows how the rough
    // Week 2 model's scores are calibrated.
    HOTSPOT_SEVERITY_THRESHOLDS: thresholdsTriple.default('0.6,0.75,0.9'),
    // An open alert for the same cell/corridor-state suppresses a new one of
    // equal-or-lower severity for this long (alert-fatigue guard).
    SUPPRESSION_WINDOW_HOURS: z.coerce.number().positive().default(24),

    // Week 3 -- Pipeline C. 'template' until Engineer 3's model call lands
    // (src/gemini/modelCall.ts). Timeout must stay well under the push
    // subscription's ack deadline (Terraform: 120 s) -- one call per event.
    BRIEFING_GENERATOR: z.enum(['template', 'gemini']).default('template'),
    BRIEFING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(90_000).default(30_000),
  })
  .superRefine((e, ctx) => {
    if (e.PUBSUB_PUSH_AUTH === 'oidc') {
      if (!e.PUBSUB_PUSH_AUDIENCE) {
        ctx.addIssue({ code: 'custom', path: ['PUBSUB_PUSH_AUDIENCE'], message: 'required when PUBSUB_PUSH_AUTH=oidc' });
      }
      if (!e.PUBSUB_PUSH_SA_EMAIL) {
        ctx.addIssue({ code: 'custom', path: ['PUBSUB_PUSH_SA_EMAIL'], message: 'required when PUBSUB_PUSH_AUTH=oidc' });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('\u274c Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
