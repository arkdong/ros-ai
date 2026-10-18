import { z } from 'zod';

/** One model name the app asks for, mapped to whatever really serves it today. Swapping the
 * provider model, price or temperature here needs no app release. */
const modelSchema = z.object({
  upstream: z.string().min(1),
  inputUsdPerMillion: z.number().positive(),
  outputUsdPerMillion: z.number().positive(),
  contextTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive(),
});
export type CloudModel = z.infer<typeof modelSchema> & { name: string };

// Token Factory ids as its catalogue listed them on 2026-10-18; prices from secondary listings.
// The catalogue check at start confirms the ids exist, and ROS_CLOUD_MODELS overrides any of this without a code change.
const DEFAULT_MODELS: Record<string, z.infer<typeof modelSchema>> = {
  ros: { upstream: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', inputUsdPerMillion: 0.06, outputUsdPerMillion: 0.24, contextTokens: 131_072, temperature: 0.6, maxOutputTokens: 8000 },
  'ros-deep': { upstream: 'nvidia/nemotron-3-super-120b-a12b', inputUsdPerMillion: 0.30, outputUsdPerMillion: 0.90, contextTokens: 131_072, temperature: 0.6, maxOutputTokens: 8000 },
};

const env = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET needs at least 32 characters.'),
  ROS_CLOUD_URL: z.string().url().default('http://127.0.0.1:4400'),
  PORT: z.coerce.number().int().default(4400),
  UPSTREAM_URL: z.string().url().default('https://api.tokenfactory.us-central1.nebius.com/v1'),
  NEBIUS_API_KEY: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().optional(), GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(), GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Email and password is for test accounts until an email sender exists for sign-in links.
  ROS_CLOUD_EMAIL_PASSWORD: z.enum(['0', '1']).default('0'),
  ROS_CLOUD_DAILY_USD: z.coerce.number().min(0).default(0.5),
  ROS_CLOUD_POOL_USD: z.coerce.number().min(0).default(100),
  ROS_CLOUD_MODELS: z.string().optional(),
}).parse(process.env);

const models = { ...DEFAULT_MODELS, ...(env.ROS_CLOUD_MODELS ? z.record(z.string(), modelSchema).parse(JSON.parse(env.ROS_CLOUD_MODELS)) : {}) };

export const config = {
  databaseUrl: env.DATABASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  publicUrl: env.ROS_CLOUD_URL.replace(/\/+$/, ''),
  port: env.PORT,
  upstreamUrl: env.UPSTREAM_URL.replace(/\/+$/, ''),
  upstreamKey: env.NEBIUS_API_KEY,
  github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined,
  google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined,
  emailPassword: env.ROS_CLOUD_EMAIL_PASSWORD === '1',
  dailyUsd: env.ROS_CLOUD_DAILY_USD,
  poolUsd: env.ROS_CLOUD_POOL_USD,
  models: Object.entries(models).map(([name, model]): CloudModel => ({ name, ...model })),
  /** The one client allowed to ask for device codes: the ros.ai app. */
  appClientId: 'ros-ai-app',
};
