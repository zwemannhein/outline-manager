/**
 * Server-side Outline API client
 * Calls the Outline Management API directly using Node.js https module
 * Used by server-side code (API routes, webhooks) where relative fetch won't work
 */

import https from "https";
import type { AccessKey } from "./types";

function buildAgent(certSha256: string): https.Agent {
  const normalized = certSha256.replace(/:/g, "").toUpperCase();
  return new https.Agent({
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      const actual = (cert.fingerprint256 ?? "").replace(/:/g, "").toUpperCase();
      if (actual !== normalized) {
        return new Error(`Cert mismatch. Expected: ${normalized} Got: ${actual}`);
      }
      return undefined;
    },
  });
}

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function outlineFetch<T>(
  apiUrl: string,
  certSha256: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const agent = buildAgent(certSha256);
  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const serialized = body !== undefined ? JSON.stringify(body) : undefined;

  const { status, data } = await httpsRequest(url, {
    method,
    agent,
    headers: {
      "Content-Type": "application/json",
      ...(serialized ? { "Content-Length": Buffer.byteLength(serialized).toString() } : {}),
    },
  }, serialized);

  if (status === 204 || status === 205) return undefined as T;

  const parsed = data.trim() ? JSON.parse(data) : {};
  if (status < 200 || status >= 300) {
    throw new Error(parsed.error ?? `HTTP ${status}`);
  }
  return parsed as T;
}

export async function serverCreateAccessKey(
  apiUrl: string,
  certSha256: string,
  name: string
): Promise<AccessKey> {
  const key = await outlineFetch<AccessKey>(apiUrl, certSha256, "POST", "/access-keys");

  // Set name
  await outlineFetch(apiUrl, certSha256, "PUT", `/access-keys/${key.id}/name`, { name });
  key.name = name;

  return key;
}

export async function serverSetDataLimit(
  apiUrl: string,
  certSha256: string,
  keyId: string,
  bytes: number
): Promise<void> {
  await outlineFetch(apiUrl, certSha256, "PUT", `/access-keys/${keyId}/data-limit`, {
    limit: { bytes },
  });
}
