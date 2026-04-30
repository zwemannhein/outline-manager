/**
 * /api/outline  — Serverless proxy for Outline Management API
 *
 * Accepts POST with JSON body:
 *   { apiUrl, certSha256, method, path, body? }
 *
 * Uses a custom https.Agent that validates the server's self-signed cert
 * against the provided SHA-256 fingerprint instead of the system CA store.
 *
 * Node.js runtime is required (not Edge) because we use the `https` module.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import type { IncomingMessage } from "http";

interface ProxyRequestBody {
  apiUrl: string;
  certSha256: string;
  method: string;
  path: string;
  body?: unknown;
}

/** Perform an HTTPS request and return { status, data } */
function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Build a custom https.Agent that pins the cert by SHA-256 fingerprint */
function buildAgent(expectedSha256: string): https.Agent {
  const normalized = expectedSha256.replace(/:/g, "").toUpperCase();

  return new https.Agent({
    rejectUnauthorized: false, // we do manual fingerprint check below
    checkServerIdentity: (_host, cert) => {
      // cert.fingerprint256 is "AA:BB:CC:..." format
      const actual = (cert.fingerprint256 ?? "")
        .replace(/:/g, "")
        .toUpperCase();

      if (actual !== normalized) {
        return new Error(
          `Certificate fingerprint mismatch.\nExpected: ${normalized}\nGot:      ${actual}`
        );
      }
      return undefined; // OK
    },
  });
}

export async function POST(req: NextRequest) {
  let body: ProxyRequestBody;

  try {
    body = (await req.json()) as ProxyRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiUrl, certSha256, method, path, body: requestBody } = body;

  if (!apiUrl || !certSha256 || !method || !path) {
    return NextResponse.json(
      { error: "Missing required fields: apiUrl, certSha256, method, path" },
      { status: 400 }
    );
  }

  // Validate method
  const allowedMethods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  if (!allowedMethods.includes(method.toUpperCase())) {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Build target URL — strip trailing slash from apiUrl, ensure path starts with /
  const base = apiUrl.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const targetUrl = `${base}${normalizedPath}`;

  let agent: https.Agent;
  try {
    agent = buildAgent(certSha256);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to build TLS agent: ${String(err)}` },
      { status: 500 }
    );
  }

  const serializedBody =
    requestBody !== undefined ? JSON.stringify(requestBody) : undefined;

  const options: https.RequestOptions = {
    method: method.toUpperCase(),
    agent,
    headers: {
      "Content-Type": "application/json",
      ...(serializedBody
        ? { "Content-Length": Buffer.byteLength(serializedBody).toString() }
        : {}),
    },
  };

  try {
    const { status, data } = await httpsRequest(targetUrl, options, serializedBody);

    // Log for debugging
    console.log(`[outline-proxy] ${method} ${targetUrl} → ${status}`, data.slice(0, 200));

    // 204 No Content and other no-body success codes — return empty response
    const NO_BODY_STATUSES = [204, 205, 304];
    if (NO_BODY_STATUSES.includes(status)) {
      return new Response(null, { status });
    }

    // Parse JSON if possible, otherwise return raw text
    let parsed: unknown;
    try {
      parsed = data.trim() ? JSON.parse(data) : {};
    } catch {
      parsed = data;
    }

    return NextResponse.json(parsed, { status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[outline-proxy] Request failed:", message);
    return NextResponse.json(
      { error: `Proxy request failed: ${message}` },
      { status: 502 }
    );
  }
}
