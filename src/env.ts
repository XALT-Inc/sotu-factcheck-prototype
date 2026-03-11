import { z } from 'zod';
import 'dotenv/config';

function booleanString(defaultValue: boolean) {
  return z
    .string()
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v.trim().toLowerCase() === 'true');
}

const envSchema = z.object({
  // Required
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required for transcription'),

  // Optional API keys
  GOOGLE_FACT_CHECK_API_KEY: z.string().default(''),
  FRED_API_KEY: z.string().default(''),
  CONGRESS_API_KEY: z.string().default(''),

  // Models
  GEMINI_TRANSCRIBE_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_VERIFY_MODEL: z.string().default('gemini-2.5-flash'),

  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),

  // Pipeline
  CHUNK_SECONDS: z.coerce.number().int().min(5).max(30).default(15),
  MAX_RESEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  CLAIM_DETECTION_THRESHOLD: z.coerce.number().min(0.55).max(0.9).default(0.62),

  // Context
  SPEECH_CONTEXT: z.string().default(''),
  OPERATOR_NOTES: z.string().default(''),

  // Auth
  CONTROL_PASSWORD: z.string().default(''),
  PROTECT_READ_ENDPOINTS: booleanString(process.env.NODE_ENV === 'production'),
  CONTROL_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(30).max(2000).default(120),

  // Ingest resilience
  INGEST_RECONNECT_ENABLED: booleanString(true),
  INGEST_MAX_RETRIES: z.coerce.number().int().min(0).max(10000).default(0),
  INGEST_RETRY_BASE_MS: z.coerce.number().int().min(100).max(120000).default(1000),
  INGEST_RETRY_MAX_MS: z.coerce.number().int().min(100).max(600000).default(15000),
  INGEST_STALL_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(45000),
  INGEST_VERBOSE_LOGS: booleanString(false),

  // Render
  TAKUMI_RENDER_URL: z.string().default(''),
  RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(5000),

  // Database
  DATABASE_URL: z.string().default(''),

  // Deployment
  DOMAIN: z.string().default(''),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const formatted = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      console.error(`Environment validation failed:\n${formatted}`);
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}

export function resetEnvCache(): void {
  _env = null;
}
