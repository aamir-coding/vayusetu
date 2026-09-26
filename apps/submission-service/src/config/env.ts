import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  AUTH_MODE: z.enum(['firebase', 'mock']).default('firebase'),
  DEFAULT_STATE_CODE: z.string().default('DL'),
  DEFAULT_DISTRICT_CODE: z.string().default('DL-CENTRAL'),
  CORS_ORIGIN: z.string().default('*'),
  // Citizen-media bucket (Terraform output `citizen_media_bucket`). Unset =>
  // POST /submissions/upload-url returns a clear 500 and POST /submissions
  // skips the media-ownership check (local dev without GCS).
  MEDIA_BUCKET: z.string().optional(),
  // Per-USER, not per-IP: Indian mobile carriers put thousands of phones
  // behind one CGNAT address, so an IP limit would throttle a whole town.
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(60),
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
