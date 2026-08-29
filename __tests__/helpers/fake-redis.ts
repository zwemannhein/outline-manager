/**
 * Minimal in-memory Redis double covering the operations used by
 * lib/admin-auth.ts, lib/login-attempts.ts and lib/password-reset.ts.
 *
 * Importantly it models HSETNX and HINCRBY faithfully, since the atomicity of
 * the login and reset state machines rests on those two commands.
 */

type Hash = Record<string, string>;

interface Entry {
  type: "hash" | "string" | "set" | "zset";
  hash?: Hash;
  str?: string;
  set?: Set<string>;
  /** member -> score, for sorted sets. */
  zset?: Map<string, number>;
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
      if (e.zset) parts.push(Array.from(e.zset.keys()).join(","));
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
    const raw = h[field];
    // Mirror Upstash, which returns numbers for numeric-looking values.
    if (/^-?\d+$/.test(raw)) return Number(raw) as unknown as T;
    return raw as unknown as T;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = this.live(key)?.hash;
    if (!h) return 0;
    let n = 0;
    for (const f of fields) {
      if (f in h) {
        delete h[f];
        n += 1;
      }
    }
    return n;
  }

  async incr(key: string): Promise<number> {
    const e = this.live(key);
    const current = e?.str ? Number(e.str) || 0 : 0;
    const next = current + 1;
    this.store.set(key, {
      type: "string",
      str: String(next),
      expiresAtMs: e?.expiresAtMs,
    });
    return next;
  }

  async hgetall<T = Record<string, string>>(key: string): Promise<T | null> {
    const h = this.live(key)?.hash;
    if (!h || Object.keys(h).length === 0) return null;
    return { ...h } as unknown as T;
  }

  // ── string commands ─────────────────────────────────────────────────────────

  /**
   * Mirrors @upstash/redis: non-string values are JSON-serialised, and `nx`
   * makes the write conditional (which is how the approval lock works).
   */
  async set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: boolean }
  ): Promise<string | null> {
    if (opts?.nx && this.live(key)) return null;

    this.store.set(key, {
      type: "string",
      str: typeof value === "string" ? value : JSON.stringify(value),
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

  async setex(key: string, seconds: number, value: unknown): Promise<string | null> {
    return this.set(key, typeof value === "string" ? value : JSON.stringify(value), {
      ex: seconds,
    });
  }

  // ── sorted sets (the cron due indexes) ──────────────────────────────────────

  async zadd(
    key: string,
    ...entries: Array<{ score: number; member: string }>
  ): Promise<number> {
    let e = this.live(key);
    if (!e) {
      e = { type: "zset", zset: new Map() };
      this.store.set(key, e);
    }
    if (!e.zset) e.zset = new Map();

    let added = 0;
    for (const { score, member } of entries) {
      if (!e.zset.has(member)) added += 1;
      e.zset.set(member, score);
    }
    return added;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const e = this.live(key);
    if (!e?.zset) return 0;
    let n = 0;
    for (const m of members) if (e.zset.delete(m)) n += 1;
    return n;
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const e = this.live(key);
    if (!e?.zset) return null;
    const score = e.zset.get(member);
    return score === undefined ? null : score;
  }

  async zcard(key: string): Promise<number> {
    return this.live(key)?.zset?.size ?? 0;
  }

  /**
   * Supports the byScore form used by the cron: members with
   * min <= score <= max, ascending, optionally windowed.
   */
  async zrange(
    key: string,
    min: number | string,
    max: number | string,
    opts?: { byScore?: boolean; offset?: number; count?: number }
  ): Promise<string[]> {
    const e = this.live(key);
    if (!e?.zset) return [];

    const lo = typeof min === "string" ? Number(min) : min;
    const hi = typeof max === "string" ? Number(max) : max;

    let entries = Array.from(e.zset.entries()).sort((a, b) => a[1] - b[1]);

    if (opts?.byScore) {
      entries = entries.filter(([, score]) => score >= lo && score <= hi);
    } else {
      const start = lo < 0 ? Math.max(0, entries.length + lo) : lo;
      const end = hi < 0 ? entries.length + hi : hi;
      entries = entries.slice(start, end + 1);
    }

    const offset = opts?.offset ?? 0;
    const count = opts?.count ?? entries.length;
    return entries.slice(offset, offset + count).map(([member]) => member);
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

    // ── Dynamic identity: guarded status change with rev bump ──
    if (norm.includes("if ARGV[1] ~= '' and status ~= ARGV[1] then return status end")) {
      const [expected, next, nowIso, suspendedArg] = a;
      const h = this.live(keys[0])?.hash;
      if (!h || h.status === undefined) return "missing";
      if (expected !== "" && h.status !== expected) return h.status;

      let rev = Number(h.rev ?? "1") || 1;
      // rev only moves when the public projection actually changes.
      if (h.status !== next) rev += 1;

      h.status = next;
      h.rev = String(rev);
      h.updatedAt = nowIso;
      if (suspendedArg !== "-") h.suspendedState = suspendedArg;
      return `ok:${rev}`;
    }

    // ── Dynamic identity: repoint at a new Outline key (three keys) ──
    if (norm.includes("redis.call('SET', KEYS[2], ARGV[5])")) {
      const [destServerId, destKeyId, destAccessUrl, nowIso, token, historyJson, status] = a;
      const h = this.live(keys[0])?.hash;
      if (!h || h.status === undefined) return "missing";

      const rev = (Number(h.rev ?? "1") || 1) + 1;
      h.serverId = destServerId;
      h.outlineKeyId = destKeyId;
      h.accessUrl = destAccessUrl;
      h.updatedAt = nowIso;
      h.rev = String(rev);
      h.history = historyJson;
      h.status = status;

      await this.set(keys[1], token);
      if (keys[2] !== keys[1]) await this.del(keys[2]);
      return `ok:${rev}`;
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
