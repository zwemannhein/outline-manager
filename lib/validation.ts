/**
 * Input validation schemas using Zod
 */

import { z } from "zod";

// ── Order validation ──────────────────────────────────────────────────────────

export const createOrderSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100, "Name too long")
    .regex(/^[a-zA-Z0-9\s\-_.]+$/, "Name contains invalid characters"),
  kpayRef: z
    .string()
    .length(6, "KPay reference must be exactly 6 digits")
    .regex(/^\d{6}$/, "KPay reference must be numeric"),
  plan: z.enum(["plan_a", "plan_b", "custom"]),
  serverId: z.string().min(1, "Please select a server").optional(),
  customDataLimitGB: z.number().int().min(1).max(10000).nullable().optional(),
  customMonths: z.number().int().min(1).max(24).nullable().optional(),
  customDevices: z.string().max(50).nullable().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

// ── Key check validation ──────────────────────────────────────────────────────

export const keyCheckSchema = z.object({
  ssHost: z.string().min(1, "Host is required"),
  keyId: z.string().optional(),
  password: z.string().optional(),
});

export type KeyCheckInput = z.infer<typeof keyCheckSchema>;

// ── Server validation ─────────────────────────────────────────────────────────

export const addServerSchema = z.object({
  name: z.string().min(1).max(100),
  apiUrl: z.string().url("Invalid API URL"),
  certSha256: z
    .string()
    .regex(
      /^[A-Fa-f0-9:]{95}$|^[A-Fa-f0-9]{64}$/,
      "Invalid SHA-256 fingerprint format"
    ),
});

export type AddServerInput = z.infer<typeof addServerSchema>;

// ── Admin auth validation ─────────────────────────────────────────────────────

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

// ── Key management validation ─────────────────────────────────────────────────

export const createKeySchema = z.object({
  name: z.string().min(1).max(100),
});

export const setDataLimitSchema = z.object({
  bytes: z.number().int().positive().nullable(),
});

export const setExpirySchema = z.object({
  expiryDate: z.string().datetime().nullable(),
});

// ── Environment validation ────────────────────────────────────────────────────

export const envSchema = z.object({
  ADMIN_USERNAME: z.string().min(1, "ADMIN_USERNAME is required"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  KV_REST_API_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  KV_REST_API_TOKEN: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

// Validate environment on module load (server-side only)
let validatedEnv: Env | null = null;

export function getEnv(): Env {
  if (validatedEnv) return validatedEnv;

  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    throw new Error(`Environment validation failed:\n${errors.join("\n")}`);
  }

  validatedEnv = result.data;
  return validatedEnv;
}

// For testing: reset validated env
export function resetEnv(): void {
  validatedEnv = null;
}
