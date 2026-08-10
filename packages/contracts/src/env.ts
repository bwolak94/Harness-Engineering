import { z } from "zod";

/**
 * Environment schema — the single place where process.env is read.
 * Parse this once in the composition root; never access process.env elsewhere.
 */
const EnvSchema = z.object({
  // Database
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .describe("PostgreSQL connection string"),

  // LLM (OpenAI-compatible)
  LLM_BASE_URL: z
    .string()
    .url("LLM_BASE_URL must be a valid URL")
    .default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().min(1, "LLM_API_KEY is required"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),

  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // OpenTelemetry
  OTEL_SERVICE_NAME: z.string().default("harness-server"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default("http://localhost:4318"),

  // Human-in-the-loop
  APPROVAL_WEBHOOK_URL: z.string().url().optional(),

  // Auth — HS256 symmetric key for JWT signing and verification.
  // Must be at least 32 bytes of entropy; rotated via env var change + rolling deploy.
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters")
    .optional()
    .default("change-me-in-production-at-least-32-chars"),

  // Redis (optional — rate limiter uses in-memory fallback when absent)
  REDIS_URL: z.string().url().optional(),

  // Worker process
  WORKER_ID: z.string().min(1).default("worker-1"),
  WORKER_LEASE_DURATION_MS: z.coerce.number().int().positive().default(300_000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Rate limiting — API requests per tenant per minute
  RATE_LIMIT_RPM: z.coerce.number().int().positive().default(60),

  // Budget defaults
  DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().default(100_000),
  DEFAULT_MAX_STEPS: z.coerce.number().int().positive().default(20),
  DEFAULT_MAX_COST_USD: z.coerce.number().positive().default(5.0),
  DEFAULT_MAX_WALL_CLOCK_MS: z.coerce.number().int().positive().default(300_000),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate environment variables.
 * Call once from the composition root — never call from library code.
 *
 * @throws ZodError with human-readable field errors if validation fails.
 */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  • ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    console.error(`\nFatal: invalid environment configuration:\n${errors}\n`);
    process.exit(1);
  }
  return result.data;
}
