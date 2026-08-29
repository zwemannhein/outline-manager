/**
 * Structured logging utility using Pino.
 *
 * SECURITY: every field listed in REDACT_PATHS is censored before it reaches a
 * log sink. Never bypass this logger with console.log for anything that could
 * contain an Outline management URL, a cert fingerprint, an access key, a
 * credential, a JWT, or a dynamic-key/login secret.
 */

import pino from "pino";

const isDevelopment = process.env.NODE_ENV === "development";

/**
 * Sensitive field names. Each is redacted at the top level and one level deep
 * (`*.field`), which covers the `logger.error({ error, ctx }, msg)` shape used
 * throughout the API routes.
 */
const SENSITIVE_FIELDS = [
  // Outline management credentials
  "apiUrl",
  "certSha256",
  // Access credentials
  "accessUrl",
  "password",
  "secret",
  "browserSecret",
  // Auth material
  "token",
  "jwt",
  "authorization",
  "Authorization",
  "claimToken",
  "browserSecretHash",
  // Infrastructure credentials
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "CF_KV_API_TOKEN",
];

const REDACT_PATHS = [
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((f) => `*.${f}`),
  // Explicit nested paths that the wildcard cannot reach
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "server.apiUrl",
  "server.certSha256",
  "servers[*].apiUrl",
  "servers[*].certSha256",
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  // Disable pino-pretty in development to avoid webpack issues
  // Use simple JSON output instead
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    env: process.env.NODE_ENV,
  },
});

// Create child loggers for different modules
export const createLogger = (module: string) => logger.child({ module });

/**
 * Truncate a security-bearing identifier for safe logging.
 * Use for dynamic-key tokens and login attempt ids, which should be
 * correlatable in logs without being reusable from them.
 */
export function maskId(value: string | null | undefined): string {
  if (!value) return "none";
  return value.length <= 8 ? "********" : `${value.slice(0, 8)}...`;
}
