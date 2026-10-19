import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/.+$/, 'Expected a MongoDB connection URI'),
  // The assignment service copies this duration into each attempt's
  // expiresAt. Configuration changes must not rewrite deadlines already stored.
  ASSIGNMENT_RESPONSE_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(604800000)
    .default(7200000),
  TIMEOUT_SCAN_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(5000),
});

export function parseEnv(input: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    // Print field names only: URI validation must never disclose credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  return result.data;
}

export type AppConfig = ReturnType<typeof parseEnv>;
