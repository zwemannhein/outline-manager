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

/** Minimum admin password length, shared by change-password and reset. */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

const attemptIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "Invalid attempt id");
const browserSecretSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Invalid browser secret");
const resetIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "Invalid reset id");
const newPasswordSchema = z
  .string()
  .min(MIN_ADMIN_PASSWORD_LENGTH, `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`)
  .max(200, "Password too long");

/** Browser polling / cancelling a pending Telegram login approval. */
export const loginAttemptSchema = z.object({
  attemptId: attemptIdSchema,
  browserSecret: browserSecretSchema,
});

/** Authenticated dashboard password change. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: newPasswordSchema,
});

/**
 * Forgot Password request. Deliberately takes NO username: the admin may have
 * forgotten it, so the server resolves it and sends it over Telegram.
 * `previousResetId` is optional and only used by "Resend" to invalidate the
 * code that was issued before.
 */
export const forgotPasswordSchema = z.object({
  previousResetId: resetIdSchema.optional().nullable(),
});

export const verifyResetCodeSchema = z.object({
  resetId: resetIdSchema,
  code: z.string().regex(/^[0-9]{6}$/, "Code must be 6 digits"),
});

export const resetPasswordSchema = z.object({
  resetId: resetIdSchema,
  newPassword: newPasswordSchema,
});

// ── Dynamic access key / VPN core ──────────────────────────────────────────────

const dynamicTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "Invalid dynamic token");

/** Customer order status lookup. Keyed on the claim token, never the order id. */
export const orderStatusSchema = z.object({
  claimToken: z.string().regex(/^[0-9a-f]{32}$/, "Invalid claim token"),
});

export const approveOrderSchema = z.object({
  serverId: z.string().min(1).optional().nullable(),
});

/** Admin: disable a customer identity. */
export const disableDynamicSchema = z.object({
  token: dynamicTokenSchema,
  reason: z.enum(["manual", "expiry"]).optional(),
});

export const enableDynamicSchema = z.object({
  token: dynamicTokenSchema,
  /** Optional destination when the underlying key must be recreated. */
  serverId: z.string().min(1).optional().nullable(),
});

/** Admin: move a customer to a different Outline server. */
export const migrateDynamicSchema = z.object({
  token: dynamicTokenSchema,
  destServerId: z.string().min(1, "Destination server is required"),
  /**
   * Emergency override for server decommission. Without it, migrating a
   * customer whose cycle quota is already exhausted returns 409.
   */
  allowExhausted: z.boolean().optional(),
});

export const migrateCleanupSchema = z.object({
  token: dynamicTokenSchema,
});

/** Admin: extend a subscription without changing the permanent URL. */
export const renewDynamicSchema = z.object({
  token: dynamicTokenSchema,
  additionalCycles: z.number().int().min(1).max(24),
});

/** Admin: change the per-cycle quota. Must not alter the permanent URL. */
export const updateQuotaSchema = z.object({
  token: dynamicTokenSchema,
  /** null = unlimited. */
  quotaGB: z.number().min(0).max(100000).nullable(),
});

export const keyMetaPatchSchema = z.object({
  expiryDate: z.string().datetime().nullable().optional(),
  quotaBytes: z.number().int().min(0).nullable().optional(),
  cyclesTotal: z.number().int().min(1).max(60).optional(),
});

export const backfillSchema = z.object({
  dryRun: z.boolean().optional(),
  /** Bound the work per invocation so a run cannot exhaust the KV write budget. */
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * First-run password setup. Takes no current password: the caller already proved
 * possession of the bootstrap password and passed Telegram approval to obtain
 * the JWT that authorises this call.
 */
export const bootstrapPasswordSchema = z.object({
  newPassword: newPasswordSchema,
});

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
  // Optional: only used to bootstrap the very first login. Once the `admin:auth`
  // record exists in Redis it is authoritative and this value is ignored.
  ADMIN_PASSWORD: z
    .string()
    .min(8, "ADMIN_PASSWORD must be at least 8 characters")
    .optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  KV_REST_API_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  KV_REST_API_TOKEN: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Telegram. TELEGRAM_WEBHOOK_SECRET is optional so existing deployments keep
  // working, but when present the webhook enforces it on every delivery.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
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
