import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TIDAL_COUNTRY: z.string().length(2).default('US'),
  GEEKED_API_KEY: z.string().min(1).default('amp_29b2lIr4mze4tK-P8QDOxfMZ9anCgJ9_uGTUks3nIyo'),
  PUBLIC_URL: z.url().optional(),
  // Launch Chromium with --no-sandbox --disable-dev-shm-usage (needed in Docker).
  CHROME_NO_SANDBOX: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const config: Config = parsed.data;
