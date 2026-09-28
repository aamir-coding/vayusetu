import { z } from 'zod';

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8086),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),
    CORS_ORIGIN: z.string().default('*'),
    // REST auth: Firebase ID tokens; `mock` accepts `mock-token:<uid>` (dev only).
    AUTH_MODE: z.enum(['firebase', 'mock']).default('firebase'),

    // analysis.completed push (fast path)
    PUBSUB_PUSH_AUTH: z.enum(['oidc', 'off']).default('oidc'),
    PUBSUB_PUSH_AUDIENCE: z.string().optional(),
    PUBSUB_PUSH_SA_EMAIL: z.string().email().optional(),

    BQ_DATASET: z.string().default('core'),
    BQ_LOCATION: z.string().default('asia-south1'),

    // Scoring: heuristic (bootstrap) | endpoint (online, always-on node) | batch (per-run job)
    HOTSPOT_SCORER: z.enum(['heuristic', 'endpoint', 'batch']).default('heuristic'),
    VERTEX_LOCATION: z.string().default('asia-south1'),
    HOTSPOT_ENDPOINT_ID: z.string().optional(),
    // Registry model resource (projects/.../models/<id>); batch scores its `default` alias.
    HOTSPOT_MODEL: z.string().optional(),
    // Run the model only on hours divisible by this (UTC); the heuristic
    // scores the hours between. 6 = one Vertex batch job per 6 h (cost).
    HOTSPOT_MODEL_EVERY_HOURS: z.coerce.number().int().min(1).max(24).default(1),

    // PRODUCT_SPEC Feature 2: isHidden = confidence high AND no monitor within 3 km.
    HIDDEN_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
    // The model's tuned best-F1 threshold (ml evaluate_and_promote label
    // vayusetu-threshold). Model probabilities are calibrated so this value
    // maps onto HIDDEN_MIN_CONFIDENCE (domain/fusion.ts calibrate); one
    // threshold then applies to every scorer. Empty = no calibration.
    MODEL_HIDDEN_MIN_CONFIDENCE: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(1).optional()),
    FIRESTORE_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),
    FIRESTORE_MIN_CELLS: z.coerce.number().int().min(0).default(25),
    FIRESTORE_MAX_CELLS: z.coerce.number().int().positive().default(400),
    // Same as alert-service's `watch` threshold (HOTSPOT_SEVERITY_THRESHOLDS[0]).
    ALERT_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.6),
    ALERT_MAX_PER_CORRIDOR: z.coerce.number().int().positive().default(25),
    // Citizen-evidence gate (same as ingestion `rollup`).
    CITIZEN_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
    CITIZEN_MIN_AGREEMENT: z.coerce.number().min(0).max(1).default(0.4),
  })
  .superRefine((e, ctx) => {
    if (e.PUBSUB_PUSH_AUTH === 'oidc' && (!e.PUBSUB_PUSH_AUDIENCE || !e.PUBSUB_PUSH_SA_EMAIL)) {
      ctx.addIssue({ code: 'custom', path: ['PUBSUB_PUSH_AUDIENCE'], message: 'audience + SA email required when PUBSUB_PUSH_AUTH=oidc' });
    }
    if (e.HOTSPOT_SCORER === 'endpoint' && !e.HOTSPOT_ENDPOINT_ID) {
      ctx.addIssue({ code: 'custom', path: ['HOTSPOT_ENDPOINT_ID'], message: 'required when HOTSPOT_SCORER=endpoint' });
    }
    if (e.HOTSPOT_SCORER === 'batch' && !e.HOTSPOT_MODEL) {
      ctx.addIssue({ code: 'custom', path: ['HOTSPOT_MODEL'], message: 'required when HOTSPOT_SCORER=batch' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
