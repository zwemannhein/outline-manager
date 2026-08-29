/**
 * In-memory Outline Management API double.
 *
 * Models the behaviour the product actually depends on:
 *  - keys have an id, name, accessUrl and optional data limit
 *  - `/metrics/transfer` reports per-key bytes
 *  - a key that is over its limit stops passing traffic (mirroring
 *    enforceAccessKeyDataLimits filtering it out of the live config)
 *
 * Also counts POSTs to `/access-keys`, which is how the tests prove the approval
 * flow and the backfill create exactly the number of keys they should.
 */

export interface FakeKey {
  id: string;
  name: string;
  password: string;
  accessUrl: string;
  dataLimit?: { bytes: number };
}

export interface FakeServer {
  id: string;
  name: string;
  apiUrl: string;
  certSha256: string;
}

export class FakeOutline {
  private keysByServer = new Map<string, Map<string, FakeKey>>();
  private usageByServer = new Map<string, Map<string, number>>();
  private nextId = 1;

  /** Every key creation, so tests can assert "exactly one Outline key". */
  public createCalls: Array<{ serverId: string; name?: string }> = [];
  public deleteCalls: Array<{ serverId: string; keyId: string }> = [];

  /** Force the next create on a server to fail, to test rollback safety. */
  public failCreateOn = new Set<string>();
  /** Force metrics reads on a server to throw. */
  public failMetricsOn = new Set<string>();

  servers: FakeServer[] = [];

  reset(): void {
    this.keysByServer.clear();
    this.usageByServer.clear();
    this.nextId = 1;
    this.createCalls = [];
    this.deleteCalls = [];
    this.failCreateOn.clear();
    this.failMetricsOn.clear();
    this.servers = [];
  }

  addServer(id: string, name = id): FakeServer {
    const server: FakeServer = {
      id,
      name,
      apiUrl: `https://10.0.0.1:9999/secret-${id}`,
      certSha256: "AA".repeat(32),
      };
    this.servers.push(server);
    this.keysByServer.set(id, new Map());
    this.usageByServer.set(id, new Map());
    return server;
  }

  private keys(serverId: string): Map<string, FakeKey> {
    let m = this.keysByServer.get(serverId);
    if (!m) {
      m = new Map();
      this.keysByServer.set(serverId, m);
    }
    return m;
  }

  private usage(serverId: string): Map<string, number> {
    let m = this.usageByServer.get(serverId);
    if (!m) {
      m = new Map();
      this.usageByServer.set(serverId, m);
    }
    return m;
  }

  // ── Test helpers ────────────────────────────────────────────────────────────

  /** Seed a pre-existing key, as the backfill scenario requires. */
  seedKey(serverId: string, key: Partial<FakeKey> & { id?: string }): FakeKey {
    const id = key.id ?? String(this.nextId++);
    const created: FakeKey = {
      id,
      name: key.name ?? "",
      password: key.password ?? `pw-${id}`,
      accessUrl: key.accessUrl ?? `ss://seed-${serverId}-${id}@1.2.3.4:1234/?outline=1`,
      dataLimit: key.dataLimit,
    };
    this.keys(serverId).set(id, created);
    return created;
  }

  setUsage(serverId: string, keyId: string, bytes: number): void {
    this.usage(serverId).set(keyId, bytes);
  }

  getKey(serverId: string, keyId: string): FakeKey | undefined {
    return this.keys(serverId).get(keyId);
  }

  listKeys(serverId: string): FakeKey[] {
    return Array.from(this.keys(serverId).values());
  }

  keyCount(serverId: string): number {
    return this.keys(serverId).size;
  }

  /** Total keys across all servers, for "exactly one key" assertions. */
  totalKeyCount(): number {
    let n = 0;
    this.keysByServer.forEach((m) => (n += m.size));
    return n;
  }

  /** Mirrors Outline dropping an over-limit key from the live config. */
  passesTraffic(serverId: string, keyId: string): boolean {
    const key = this.keys(serverId).get(keyId);
    if (!key) return false;
    const limit = key.dataLimit?.bytes;
    if (limit === undefined) return true;
    const used = this.usage(serverId).get(keyId) ?? 0;
    return used < limit;
  }

  // ── Request dispatch ────────────────────────────────────────────────────────

  /** Route a request the way lib/outline-admin.ts would. */
  async request(
    serverId: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    if (!this.keysByServer.has(serverId)) {
      throw Object.assign(new Error("Server is not registered"), { status: 404 });
    }

    // POST /access-keys
    if (method === "POST" && path === "/access-keys") {
      if (this.failCreateOn.has(serverId)) {
        throw Object.assign(new Error("simulated create failure"), { status: 500 });
      }
      this.createCalls.push({ serverId });
      const id = String(this.nextId++);
      const key: FakeKey = {
        id,
        name: "",
        password: `pw-${id}`,
        accessUrl: `ss://created-${serverId}-${id}@1.2.3.4:1234/?outline=1`,
      };
      this.keys(serverId).set(id, key);
      return key;
    }

    // GET /access-keys
    if (method === "GET" && path === "/access-keys") {
      return { accessKeys: this.listKeys(serverId) };
    }

    // GET /metrics/transfer
    if (method === "GET" && path === "/metrics/transfer") {
      if (this.failMetricsOn.has(serverId)) {
        throw Object.assign(new Error("metrics unavailable"), { status: 500 });
      }
      const out: Record<string, number> = {};
      this.usage(serverId).forEach((bytes, id) => (out[id] = bytes));
      return { bytesTransferredByUserId: out };
    }

    // /access-keys/<id>/name
    const nameMatch = /^\/access-keys\/([^/]+)\/name$/.exec(path);
    if (nameMatch && method === "PUT") {
      const key = this.keys(serverId).get(nameMatch[1]);
      if (!key) throw Object.assign(new Error("not found"), { status: 404 });
      key.name = (body as { name: string }).name;
      return undefined;
    }

    // /access-keys/<id>/data-limit
    const limitMatch = /^\/access-keys\/([^/]+)\/data-limit$/.exec(path);
    if (limitMatch) {
      const key = this.keys(serverId).get(limitMatch[1]);
      if (!key) throw Object.assign(new Error("not found"), { status: 404 });

      if (method === "PUT") {
        const bytes = (body as { limit: { bytes: number } }).limit.bytes;
        key.dataLimit = { bytes };
        return undefined;
      }
      if (method === "DELETE") {
        delete key.dataLimit;
        return undefined;
      }
    }

    // /access-keys/<id>
    const keyMatch = /^\/access-keys\/([^/]+)$/.exec(path);
    if (keyMatch) {
      const id = keyMatch[1];
      if (method === "GET") {
        const key = this.keys(serverId).get(id);
        if (!key) throw Object.assign(new Error("not found"), { status: 404 });
        return key;
      }
      if (method === "DELETE") {
        if (!this.keys(serverId).has(id)) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        this.deleteCalls.push({ serverId, keyId: id });
        this.keys(serverId).delete(id);
        return undefined;
      }
    }

    if (method === "GET" && path === "/server") {
      return { name: serverId, version: "1.0.0" };
    }

    throw Object.assign(new Error(`unhandled ${method} ${path}`), { status: 400 });
  }
}

export const fakeOutline = new FakeOutline();
