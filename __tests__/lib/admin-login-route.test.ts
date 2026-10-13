import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  parseJsonBody: vi.fn(),
  verifyAdminCredentials: vi.fn(),
  getCurrentAdminUsername: vi.fn(),
  createToken: vi.fn(),
}));

vi.mock("@/lib/api-utils", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
  parseJsonBody: mocks.parseJsonBody,
  handleApiError: vi.fn((error: unknown) => Response.json({ error: String(error) }, { status: 500 })),
  successResponse: vi.fn((data: unknown) => Response.json(data)),
  rateLimitResponse: vi.fn(() => Response.json({ error: "Rate limited" }, { status: 429 })),
  AppError: class AppError extends Error {},
  createToken: mocks.createToken,
}));

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminCredentials: mocks.verifyAdminCredentials,
  getCurrentAdminUsername: mocks.getCurrentAdminUsername,
}));

import { POST } from "@/app/api/v1/auth/login/route";
import { POST as pollLegacyLoginApproval } from "@/app/api/v1/auth/login/status/route";

describe("admin login route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    mocks.getClientIp.mockReturnValue("192.0.2.1");
    mocks.parseJsonBody.mockResolvedValue({ username: "admin", password: "correct-password" });
    mocks.verifyAdminCredentials.mockResolvedValue(true);
    mocks.getCurrentAdminUsername.mockResolvedValue("admin");
    mocks.createToken.mockResolvedValue("session-jwt");
  });

  it("issues a session immediately after valid credentials without Telegram approval", async () => {
    const request = new NextRequest("https://outline-manager.vercel.app/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      status: "authenticated",
      token: "session-jwt",
      username: "admin",
      expiresIn: "24h",
    });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("192.0.2.1", "login", {
      requests: 5,
      window: "15m",
    });
    expect(mocks.verifyAdminCredentials).toHaveBeenCalledWith("admin", "correct-password");
    expect(mocks.createToken).toHaveBeenCalledWith("admin");
  });

  it("does not issue sessions from legacy Telegram approval attempts", async () => {
    const response = await pollLegacyLoginApproval();
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data.code).toBe("LOGIN_APPROVAL_DISABLED");
  });
});
