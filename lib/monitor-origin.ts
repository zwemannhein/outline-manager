import { DEFAULT_DYNAMIC_HOST } from "./dynamic-url";

/**
 * Production monitoring probes the same public canonical origin used by
 * customer ssconf URLs. Deployment-specific VERCEL_URL hosts may be protected
 * and redirect probes to a login page, producing a false HTTP 200 warning.
 */
export function getMonitoringProbeBaseUrl(
  requestOrigin: string,
  environment = process.env.NODE_ENV
): string {
  return environment === "production"
    ? `https://${DEFAULT_DYNAMIC_HOST}`
    : requestOrigin;
}
