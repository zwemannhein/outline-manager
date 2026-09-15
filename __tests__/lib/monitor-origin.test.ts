import { afterEach, describe, expect, it, vi } from "vitest";
import { getMonitoringProbeBaseUrl } from "@/lib/monitor-origin";

afterEach(() => vi.unstubAllEnvs());

describe("monitoring dynamic-config probe origin", () => {
  it("uses the canonical public host in production instead of protected VERCEL_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_URL", "protected-deployment.example.vercel.app");
    expect(getMonitoringProbeBaseUrl("https://outline-manager.vercel.app")).toBe(
      "https://outline-manager.vercel.app"
    );
  });

  it("uses the request origin during local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getMonitoringProbeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
});
