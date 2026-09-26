import { z } from 'zod';

const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8083),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),
    AUTH_MODE: z.enum(['firebase', 'mock']).default('firebase'),
    CORS_ORIGIN: z.string().default('*'),

    // Identity of THIS deployment on the Exchange (NCR -> DL, Mumbai-Pune -> MH).
    FEDERATION_STATE_CODE: z.string().min(2),
    // States whose rows this deployment may publish/replace (NCR holds DL,HR,UP,RJ).
    FEDERATION_OWNED_STATES: csv.optional(),

    EXCHANGE_PROJECT_ID: z.string().min(1),
    EXCHANGE_DATASET: z.string().default('federation_exchange'),
    BIGQUERY_LOCATION: z.string().default('asia-south1'),
    VERTEX_LOCATION: z.string().default('asia-south1'),

    // k-anonymity -- see src/lib/kAnonymize.ts. k < 2 is refused at boot.
    K_MIN_CONTRIBUTORS: z.coerce.number().int().min(2).default(10),
    K_MIN_REPORTS: z.coerce.number().int().min(10).default(10),
    GENERALIZED_H3_RESOLUTION: z.coerce.number().int().min(0).max(7).default(6),

    // Feature schema this deployment's services can serve; an import whose
    // model was trained on a different schema -> 409 (contract's "incompatible
    // model schema version"). Must match Engineer 3's vayusetu-feature-schema labels.
    FEATURE_SCHEMA_VERSIONS: z
      .string()
      .default('hotspot=hs-v1,forecast=fc-v1')
      .transform((s) => Object.fromEntries(s.split(',').map((kv) => kv.split('=').map((x) => x.trim()))) as Record<string, string>),

    SUMMARY_LOOKBACK_WEEKS: z.coerce.number().int().min(1).max(12).default(4),
    IMPORT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(240_000),
  })
  .transform((e) => ({ ...e, FEDERATION_OWNED_STATES: e.FEDERATION_OWNED_STATES ?? [e.FEDERATION_STATE_CODE] }));

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('\u274c Invalid environment configuration:');
    for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
