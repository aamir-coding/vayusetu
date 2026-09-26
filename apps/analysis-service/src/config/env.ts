import { z } from 'zod';

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8088),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),

    // Pub/Sub push auth (see @vayusetu/gcp-clients pubsubPush). 'off' = local emulator only.
    PUBSUB_PUSH_AUTH: z.enum(['oidc', 'off']).default('oidc'),
    PUBSUB_PUSH_AUDIENCE: z.string().optional(),
    PUBSUB_PUSH_SA_EMAIL: z.string().email().optional(),

    // Air Quality API (live modeled AQI at the report's point, cross-validation reference).
    // Optional: without it the reference is the nearest monitor only.
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    BQ_DATASET: z.string().default('core'),
    // Pipeline B audio cache and the raw-model-response audit archive (Terraform storage.tf).
    ADVISORY_AUDIO_BUCKET: z.string().optional(),
    RAW_ARCHIVE_BUCKET: z.string().optional(),

    // Speech-to-Text v2. chirp_3 in `us` is the only verified config that
    // transcribes hi/pa/mr/en correctly (docs/context/05_AI_PIPELINES.md).
    STT_MODEL: z.string().default('chirp_3'),
    STT_LOCATION: z.string().default('us'),
    // Text-to-Speech voice suffix; the full name is `${lang}-${TTS_VOICE_SUFFIX}`.
    TTS_VOICE_SUFFIX: z.string().default('Chirp3-HD-Aoede'),

    // Pipeline D runs when Pipeline A says indeterminate below this confidence.
    CLARIFY_BELOW_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.4),
    // A monitor reading older than this is context, never the cross-validation reference.
    MONITOR_FRESH_HOURS: z.coerce.number().positive().default(6),
    MONITOR_MAX_DISTANCE_KM: z.coerce.number().positive().default(5),
  })
  .superRefine((e, ctx) => {
    if (e.PUBSUB_PUSH_AUTH === 'oidc' && (!e.PUBSUB_PUSH_AUDIENCE || !e.PUBSUB_PUSH_SA_EMAIL)) {
      ctx.addIssue({ code: 'custom', path: ['PUBSUB_PUSH_AUDIENCE'], message: 'audience + SA email required when PUBSUB_PUSH_AUTH=oidc' });
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
