import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TOKEN = "b".repeat(32);
const ACCESS_URL = `ss://${Buffer.from("chacha20:secret-password").toString("base64")}@vpn.example.com:443`;

vi.mock("@/lib/dynamic-keys", () => ({
  readDynamicRecord: vi.fn(async () => ({
    token: TOKEN,
    status: "active",
    accessUrl: ACCESS_URL,
  })),
}));

import { GET } from "@/app/k/[token]/route";

describe("canonical /k JSON resolver", () => {
  it("returns the same Outline JSON when the outer ssconf URL has a name fragment", async () => {
    const request = new NextRequest(
      `https://outline-manager.vercel.app/k/${TOKEN}#${encodeURIComponent("ကိုအောင်")}`
    );
    const response = await GET(request, { params: { token: TOKEN } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({
      method: "chacha20",
      password: "secret-password",
      server: "vpn.example.com",
      server_port: 443,
    });
  });
});
