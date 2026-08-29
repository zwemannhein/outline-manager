/**
 * Minimal in-memory Redis double covering the operations used by
 * lib/admin-auth.ts, lib/login-attempts.ts and lib/password-reset.ts.
 *
 * Importantly it models HSETNX and HINCRBY faithfully, since the atomicity of
 * the login and reset state machines rests on those two commands.
 */

type Hash = Record<string, string>;

interface Entry {
  type: "hash" | "string" | "set";
  hash?: Hash;
  str?: string;
  set?: Set<string>;
  expiresAtMs?: number;
}

export class FakeRedis {
  private store = new Map<string, Entry>();

  // ── helpers ─────────────────────────────────────────────────────────────────

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAtMs !== undefined && e.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  private ensureHash(key: string): Entry {
    let e = this.live(key);
    if (!e) {
      e = { type: "hash", hash: {} };
      this.store.set(key, e);
    }
    if (!e.hash) e.hash = {};
    return e;
  }

  /** Test-only: inspect the raw stored hash. */
  peekHash(key: string): Hash | undefined {
    return this.live(key)?.hash;
  }

  /**
   * Test-only: expire a record LOGICALLY by backdating its `expiresAtMs` field,
   * leaving the key present. This exercises the expiry branch inside the Lua
   * scripts, which read that field rather than relying on the key's TTL.
   */
  forceExpire(key: string): void {
    const e = this.store.get(key);
    if (e?.hash) e.hash.expiresAtMs = String(Date.now() - 1);
  }

  /** Test-only: remove the key entirely, as Redis does once its TTL elapses. */
  forceEvict(key: string): void {
    this.store.delete(key);
  }

  /** Test-only: dump every stored value as one string, for leak assertions. */
  dumpAll(): string {
    const parts: string[] = [];
    this.store.forEach((e, key) => {
      parts.push(key);
      if (e.hash) parts.push(JSON.stringify(e.hash));
      if (e.str) parts.push(e.str);
      if (e.set) parts.push(Array.from(e.set).join(","));
    });
    return parts.join("\n");
  }

  reset(): void {
    this.store.clear();
  }

  // ── hash commands ───────────────────────────────────────────────────────────

  async hset(key: string, values: Record<string, string | number>): Promise<number> {
    const e = this.ensureHash(key);
    let added = 0;
    for (const [f, v] of Object.entries(values)) {
      if (!(f in e.hash!)) added += 1;
      e.hash![f] = String(v);
    }
    return added;
  }

  async hsetnx(key: string, field: string, value: string | number): Promise<number> {
    const e = this.ensureHash(key);
    if (field in e.hash!) return 0;
    e.hash![field] = String(value);
    return 1;
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    const e = this.ensureHash(key);
    const next = Number(e.hash![field] ?? "0") + by;
    e.hash![field] = String(next);
    return next;
  }

  async hget<T = string>(key: string, field: string): Promise<T | null> {
    const h = this.live(key)?.hash;
    if (!h || !(field in h)) return null;
    return h[field] as unknown as T;
  }

  async hgetall<T = Record<string, string>>(key: string): Promise<T | null> {
    const h = this.live(key)?.hash;
    if (!h || Object.keys(h).length === 0) return null;
    return { ...h } as unknown as T;
  }

  // ── string commands ─────────────────────────────────────────────────────────

  async set(key: string, value: string, opts?: { ex?: number }): Promise<string> {
    this.store.set(key, {
      type: "string",
      str: String(value),
      expiresAtMs: opts?.ex ? Date.now() + opts.ex * 1000 : undefined,
    });
    return "OK";
  }

  async get<T = string>(key: string): Promise<T | null> {
    const e = this.live(key);
    if (!e) return null;
    if (e.str === undefined) return null;
    try {
      return JSON.parse(e.str) as T;
    } catch {
      return e.str as unknown as T;
    }
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }

  async exists(key: string): Promise<number> {
    return this.live(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAtMs = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAtMs === undefined) return -1;
    return Math.max(0, Math.ceil((e.expiresAtMs - Date.now()) / 1000));
  }

  // ── set commands ────────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<number> {
    let e = this.live(key);
    if (!e) {
      e = { type: "set", set: new Set() };
      this.store.set(key, e);
    }
    if (!e.set) e.set = new Set();
    let n = 0;
    for (const m of members) {
      if (!e.set.has(m)) {
        e.set.add(m);
        n += 1;
      }
    }
    return n;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const e = this.live(key);
    if (!e?.set) return 0;
    let n = 0;
    for (const m of members) if (e.set.delete(m)) n += 1;
    return n;
  }

  async smembers(key: string): Promise<string[]> {
    const e = this.live(key);
    return e?.set ? Array.from(e.set) : [];
  }

  async setex(key: string, seconds: number, value: unknown): Promise<string> {
    return this.set(key, typeof value === "string" ? value : JSON.stringify(value), {
      ex: seconds,
    });
  }

  // ── EVAL ────────────────────────────────────────────────────────────────────

  /**
   * Execute one of the project's Lua scripts.
   *
   * Each branch is a line-by-line transcription of the corresponding Lua, run
   * synchronously with no `await` inside. That mirrors the property the real
   * scripts rely on: Redis runs Lua single-threaded, so read-check-write is
   * indivisible. Because JS is likewise single-threaded and these bodies never
   * yield, concurrent callers here interleave exactly as they would in Redis,
   * which is what makes the race tests meaningful.
   *
   * NOTE: this validates the state-machine LOGIC, not the Lua syntax. The script
   * text itself is only exercised against a real Upstash instance at runtime.
   */
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    const a = args.map(String);
    const norm = script.replace(/\s+/g, " ").trim();

    // ── Login attempt CAS transition ──
    if (norm.includes("redis.call('HSET', KEYS[1], 'state', ARGV[2], ARGV[4], ARGV[5])")) {
      const [expected, next, nowMs, tsField, nowIso] = a;
      const h = this.live(keys[0])?.hash;
      if (!h || h.state === undefined) return "missing";
      const expiresAtMs = Number(h.expiresAtMs);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Number(nowMs)) return "expired";
      if (h.state !== expected) return h.state;
      h.state = next;
      h[tsField] = nowIso;
      return "ok";
    }

    // ── Reset code verification (wrong-code increment, lock, or verify) ──
    if (norm.includes("redis.call('HSET', KEYS[1], 'state', 'verified', 'verifiedAt', ARGV[3])")) {
      const [submittedHash, nowMs, nowIso, maxAttempts] = a;
      const h = this.live(keys[0])?.hash;
      if (!h || h.state === undefined) return "missing";
      const expiresAtMs = Number(h.expiresAtMs);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Number(nowMs)) return "expired";
      if (h.state !== "pending") return h.state;

      if (h.codeHash !== submittedHash) {
        const attempts = Number(h.attempts ?? "0") + 1;
        h.attempts = String(attempts);
        if (attempts >= Number(maxAttempts)) {
          h.state = "locked";
          h.lockedAt = nowIso;
          return "locked";
        }
        return `wrong:${attempts}`;
      }

      h.state = "verified";
      h.verifiedAt = nowIso;
      // "ok" (not "verified") so the caller can tell a fresh transition apart
      // from a record that was already verified.
      return "ok";
    }

    // ── Atomic password write + reset consumption (two keys) ──
    if (norm.includes("redis.call('HSET', KEYS[2], 'passwordHash', ARGV[3]")) {
      const [nowMs, nowIso, passwordHash, salt, algorithm] = a;
      const h = this.live(keys[0])?.hash;
      if (!h || h.state === undefined) return "missing";
      const expiresAtMs = Number(h.expiresAtMs);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Number(nowMs)) return "expired";
      if (h.state !== "verified") return h.state;

      const auth = this.ensureHash(keys[1]);
      auth.hash!.passwordHash = passwordHash;
      auth.hash!.salt = salt;
      auth.hash!.algorithm = algorithm;
      auth.hash!.updatedAt = nowIso;

      h.state = "consumed";
      h.consumedAt = nowIso;
      return "ok";
    }

    throw new Error("FakeRedis.eval: unrecognised script");
  }
}

export const fakeRedis = new FakeRedis();
