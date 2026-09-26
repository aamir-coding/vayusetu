import { z } from 'zod';

const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8087),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),
    CORS_ORIGIN: z.string().default('*'),
    AUTH_MODE: z.enum(['firebase', 'mock']).default('firebase'),
    BQ_DATASET: z.string().default('core'),
    BQ_LOCATION: z.string().default('asia-south1'),
    // Corridors this deployment forecasts (data/seed/corridors.json ids).
    CORRIDOR_IDS: csv.default('ncr-airshed'),
    // persistence (bootstrap baseline) | batch (AutoML Forecasting, Vertex AI batch prediction)
    FORECASTER: z.enum(['persistence', 'batch']).default('persistence'),
    VERTEX_LOCATION: z.string().default('asia-south1'),
    FORECAST_MODEL: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.FORECASTER === 'batch' && !e.FORECAST_MODEL) {
      ctx.addIssue({ code: 'custom', path: ['FORECAST_MODEL'], message: 'required when FORECASTER=batch' });
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
