# CODEX_HANDOFF.md — Complete Project Map

> **START HERE.** Read AGENTS.md and this file in full before touching any code.
> Source code is the authority. This document was reconciled with the stabilization source on 2026-08-31.

---

## A. EXECUTIVE SUMMARY

**outline-manager** is a self-hosted Outline VPN subscription management dashboard deployed on Vercel.

A single admin uses it to:
- Accept and approve customer VPN orders (with KPay payment reference)
- Issue permanent Outline access keys wrapped in a stable `ssconf://` URL
- Manage quota (GB per 30-day cycle), expiry, disable/enable, migration, and deletion
- Monitor system health across all integrated services
- Approve their own login via Telegram two-factor (any linked approver can approve)

Customers receive a stable token/path; the optional display-name fragment tracks the current customer name. The underlying Shadowsocks credentials can be rotated or migrated without changing the token.

---

## B. CURRENT TECH STACK

| Technology | Version | Where used |
|---|---|---|
| Next.js App Router | 14.2.3 | Full-stack framework, API routes, `/k/` route |
| React | ^18 | Admin dashboard UI |
| TypeScript | ^5 | Entire codebase |
| Tailwind CSS | ^3.4 | Styling; custom `xs: 480px` breakpoint added |
| Radix UI | various | Dialog, Dropdown, Label, Toast, etc. |
| Upstash Redis | ^1.37.0 | Primary data store (source of truth) |
| @upstash/ratelimit | ^2.0.3 | Login rate limiting |
| jose | ^5.9.6 | JWT session tokens |
| Zod | ^3.23.8 | All input validation schemas |
| Pino | ^9.5.0 | Structured server-side logging |
| Telegram Bot API | HTTP REST | Login approval, order notifications, approver linking |
| Outline Management API | HTTP/TLS cert-pinned | VPN server key management |
| Vercel | Hobby | Hosting, cron (daily fallback), environment secrets |
| Cloudflare Worker + KV | Free tier | Legacy/cache layer for `/k/` projection (NOT canonical) |
| AWS Lightsail | External | Physical VPN server hosting (no API credentials configured) |
| Vitest | ^2.1.8 | Test runner (25 files, 452 tests) |

---

## C. REPOSITORY STRUCTURE

```
outline-manager/
├── app/
│   ├── k/[token]/route.ts          ← CANONICAL /k/<token> JSON resolver (Vercel)
│   ├── page.tsx                    ← Root page (login + admin dashboard shell)
│   ├── layout.tsx                  ← HTML layout, font, providers
│   └── api/
│       ├── v1/
│       │   ├── auth/
│       │   │   ├── login/route.ts          ← Step 1: credentials → challenge
│       │   │   ├── login/status/route.ts   ← Step 2: poll approval status
│       │   │   ├── login/cancel/route.ts   ← Browser-initiated cancel
│       │   │   ├── verify/route.ts         ← Exchange approved challenge → JWT
│       │   │   ├── change-password/route.ts
│       │   │   ├── forgot-password/route.ts
│       │   │   ├── forgot-password/verify/route.ts
│       │   │   ├── forgot-password/reset/route.ts
│       │   │   └── bootstrap-password/route.ts  ← First-run password setup
│       │   ├── dynamic-keys/
│       │   │   ├── route.ts         ← GET: list all customers with health data
│       │   │   └── actions/route.ts ← POST: all lifecycle mutations (one endpoint)
│       │   ├── admin/
│       │   │   ├── customers/route.ts  ← POST: create customer, GET: list unmanaged keys
│       │   │   └── backfill/route.ts   ← Backfill existing Outline keys → managed customers
│       │   ├── telegram-approvers/
│       │   │   ├── route.ts             ← GET: list, DELETE: remove approver
│       │   │   └── link-token/route.ts  ← POST: create one-time linking token
│       │   ├── telegram/
│       │   │   └── webhook/route.ts    ← Handles /start (linking) + callbacks (orders, login)
│       │   ├── orders/                 ← Order CRUD, approve, reject, status
│       │   ├── monitor/
│       │   │   ├── route.ts            ← System health (app/Redis/Telegram/cron/dynconfig)
│       │   │   ├── outline/route.ts    ← Per-server Outline health + VPN port check
│       │   │   └── diagnose/route.ts   ← Per-customer read-only diagnostics
│       │   ├── cron/tick/route.ts      ← Maintenance: expiry + cycle rollover + KV drain
│       │   ├── health/route.ts         ← Simple liveness check
│       │   ├── key-check/route.ts
│       │   ├── servers/route.ts
│       │   └── store/route.ts
│       └── (legacy v0 routes under app/api/ — kept for compatibility)
│
├── components/admin/
│   ├── AdminView.tsx          ← Root admin shell, tabs: Servers/Customers/Orders/Monitoring/Settings
│   ├── CustomersPanel.tsx     ← Customer list with search, actions, Diagnose, Delete
│   ├── CustomerDialogs.tsx    ← MigrateServer, EditSubscription, AddCustomer dialogs
│   ├── DeleteCustomerDialog.tsx ← Confirmation dialog for deletion
│   ├── DiagnoseDialog.tsx     ← Per-customer read-only diagnostic panel
│   ├── MonitoringPanel.tsx    ← System health dashboard UI
│   ├── OrdersPanel.tsx        ← Order list and approval
│   ├── ServerDashboard.tsx    ← Per-server key management
│   ├── ServerSidebar.tsx      ← Server selector sidebar
│   ├── SettingsPanel.tsx      ← Telegram Approvers management
│   ├── ChangePasswordDialog.tsx
│   ├── FirstRunPasswordSetup.tsx
│   ├── Dialogs.tsx            ← Shared dialogs (AddServer, RenameKey, SetLimit, etc.)
│   └── KeyTable.tsx           ← Outline key table for ServerDashboard
│
├── lib/
│   ├── admin-auth.ts         ← Password hashing (scrypt), verify, first-run bootstrap
│   ├── api-utils.ts          ← Redis client, JWT, rate limiter, error handling, auth middleware
│   ├── backfill.ts           ← Bulk-migrate existing Outline keys into managed identities
│   ├── delete-customer.ts    ← Safe deletion: revoke → KV remove → Outline key delete
│   ├── dynamic-keys.ts       ← Core identity CRUD, Redis key constants, Lua state machine
│   ├── dynamic-lifecycle.ts  ← disable, enable, renew, updateQuota, editSubscription, migrate
│   ├── dynamic-url.ts        ← Build/parse ssconf:// URLs, token validation
│   ├── key-meta.ts           ← Per-key quota/cycle metadata: read, write, compute usage
│   ├── kv-sync.ts            ← Cloudflare KV projection: put, delete, dirty queue, drain
│   ├── login-attempts.ts     ← Login challenge state machine (Lua CAS in Redis)
│   ├── monitoring.ts         ← Health checks, cron summary, login telemetry, due-job counts
│   ├── order-approval.ts     ← Approve/reject orders, idempotent, orphan adoption
│   ├── order-claim.ts        ← One-time claim tokens for customer order status lookup
│   ├── outline-admin.ts      ← Server-side Outline API client (cert-pinned, Redis registry)
│   ├── outline-client.ts     ← Browser-side Outline proxy client (via /api/outline)
│   ├── outline-server.ts     ← Outline server registry helpers
│   ├── password-reset.ts     ← Forgot-password: HMAC code generation, verification
│   ├── polling.ts            ← Generic exponential-backoff polling utility
│   ├── quota-cycles.ts       ← 30-day cycle rollover, expiry processing (cron workers)
│   ├── server-migration.ts   ← Move customer to different Outline server (preserves token)
│   ├── storage.ts            ← Browser localStorage helpers (server list, key meta legacy)
│   ├── sync.ts               ← Browser API client (all fetch calls to v1 API, auth token mgmt)
│   ├── telegram-approvers.ts ← Approver CRUD, link token create/consume, chatId lookup
│   ├── telegram-callback.ts  ← Parse Telegram callback_data (order/login prefixes)
│   ├── telegram.ts           ← sendTelegramMessage, sendLoginApprovalRequest, etc.
│   ├── types.ts              ← Shared TypeScript types (OutlineServer, DynamicKeyRecord, etc.)
│   ├── validation.ts         ← All Zod schemas + getEnv() environment validation
│   └── utils.ts              ← cn(), formatBytes(), uuid()
│
├── worker/
│   ├── src/
│   │   ├── index.ts    ← Cloudflare Worker: /k/<token> resolver (reads CF KV, returns JSON)
│   │   └── cron.ts     ← Cloudflare scheduled Worker: calls /api/v1/cron/tick hourly
│   └── wrangler.toml   ← Worker config; workers_dev = true
│
├── __tests__/           ← 25 standard test files, 452 tests (Vitest + jsdom)
│   ├── components/      ← AdminLoginForm, FirstRunPasswordSetup
│   ├── helpers/         ← FakeRedis, FakeOutline, outline-mock
│   ├── integration/     ← Upstash live tests (opt-in, skipped in normal CI)
│   ├── lib/             ← Unit tests for all lib/ modules
│   └── worker/          ← config-worker tests
│
├── vercel.json          ← Cron schedule: /api/v1/cron/tick at 03:00 UTC daily
├── tailwind.config.ts   ← Custom xs: 480px breakpoint
├── AGENTS.md            ← Agent operating instructions (READ FIRST)
└── CODEX_HANDOFF.md     ← This file

---

## D. DATA MODEL / REDIS SCHEMA

All data lives in **Upstash Redis**. Cloudflare KV is a public read-cache only.

### Orders

| Key | Type | Purpose |
|---|---|---|
| `outline_orders` | JSON string (array) | All orders. Simple get/set — entire array. |
| `lock:order:<orderId>` | STRING TTL 30s | Distributed lock during approval to prevent duplicate keys |
| `dynpending:<orderId>` | STRING | Pending intent: reserved token before key creation completes |
| `orderclaim:<sha256hash>` | STRING TTL 30d | Maps claim token hash → orderId for customer status lookup |

### Dynamic Customer Identities

| Key | Type | Purpose |
|---|---|---|
| `dyn:<token>` | HASH | Full identity: token, serverId, outlineKeyId, accessUrl, name, status, rev, history, suspendedState, createdAt, updatedAt |
| `dynidx:all` | SET | All token strings (for full listing) |
| `dynidx:order:<orderId>` | STRING | orderId → token lookup |
| `dynidx:server:<serverId>:<keyId>` | STRING | serverId+keyId → token lookup |
| `dyn:kv_dirty` | SET | Tokens whose CF KV projection needs retry |
| `dyn:cycle_due` | ZSET score=epochMs | Tokens with cycle rollover due |
| `dyn:expiry_due` | ZSET score=epochMs | Tokens with subscription expiry due |

Identity `status` values: `active` | `disabled` | `expired` | `revoked`

`rev` is a monotonic integer; bumped whenever the public projection changes. CF KV projection is considered stale when its rev < Redis rev.

### Key Metadata (quota/cycle state)

| Key | Type | Purpose |
|---|---|---|
| `outline_key_meta` | HASH field=`<serverId>:<keyId>` | Per-key: quotaBytes, periodStart, carriedBytes, cyclesTotal, cyclesUsed, expiryDate, updatedAt |
| `outline_admin_data` (legacy) | JSON string | Old browser-writable blob; migrated to outline_key_meta on read |

### Admin Auth

| Key | Type | Purpose |
|---|---|---|
| `admin:auth` | HASH | passwordHash (scrypt), salt, algorithm, username, updatedAt |
| `adminlogin:<attemptId>` | HASH TTL 5m | Login challenge: state, browserSecretHash, username, ip, userAgent, expiresAtMs |
| `adminlogin:pending` | SET | Active attempt IDs (for pending count check) |

### Telegram Approvers

| Key | Type | Purpose |
|---|---|---|
| `tg:approvers` | SET | All linked approver userId strings |
| `tg:approver:<userId>` | HASH | userId, chatId, username, linkedAt, status |
| `tg:link:<token>` | HASH TTL 15m | expectedUsername, createdAt, expiresAtMs — consumed on first use |
| `tg:links:pending` | SET | Pending link tokens (best-effort cleanup set) |

### Monitoring

| Key | Type | Purpose |
|---|---|---|
| `monitor:cron:last` | HASH TTL 25h | lastStartedAt, lastCompletedAt, durationMs, processed, failed, expiryProcessed, quotaProcessed, dirtySyncProcessed |
| `monitor:login:last` | HASH TTL 7d | challengeCreatedAt, recipientsAttempted, deliverSucceeded, deliverFailed, lastFailureCategory (sanitised) |
| `monitor:system:cache` | STRING TTL 30s | Cached system health JSON payload |
| `monitor:outline:cache` | STRING TTL 30s | Cached Outline health JSON payload |
| `monitor:ping` | STRING TTL 10s | Redis liveness probe value |

### Other

| Key | Type | Purpose |
|---|---|---|
| `outline_admin_data` | JSON string | Outline server registry (apiUrl, certSha256 per server) |
| `kvwrites:<YYYY-MM-DD>` | STRING | Daily CF KV write counter (free tier budget tracking) |
| `kvsynced:<token>` | STRING | Last successfully synced rev for a token |
| `ratelimit:*` | Various | @upstash/ratelimit sliding window data |
| `password_reset:*` | HASH TTL | Reset code state machine |

---

## E. CUSTOMER FLOW

### Public Order Flow

```
Customer submits order form (name, KPay ref, plan)
  → POST /api/v1/orders (creates order, returns claimToken once)
  → Telegram notification sent to all configured chatIds
  → Admin sees order in Orders tab

Admin approves (dashboard or Telegram button)
  → POST /api/v1/orders/<id>/approve
  → Outline key created on selected server
  → DynamicKeyRecord created in Redis (status=active, rev=1)
  → Cloudflare KV projection written (accessUrl, status, rev)
  → Permanent ssconf:// URL built from the unchanged token plus encoded display-name fragment
  → Order marked approved, dynamicToken stored on order
  → claimToken stored → customer can poll /api/v1/orders/status with it
```

### Admin Add Customer (no order)

Two modes via `POST /api/v1/admin/customers`:

**Create New Key:** Creates a fresh Outline key on the specified server, then creates a DynamicKeyRecord linked to it. No order record created.

**Use Existing Key:** Attaches an existing unmanaged Outline key (one not yet tracked by any DynamicKeyRecord). Duplicate-key protection via `dynidx:server:<serverId>:<keyId>` lookup.

---

## F. ADMIN AUTH FLOW

```
1. POST /api/v1/auth/login
   - Verify username + password (scrypt, timing-safe)
   - Create LoginAttempt in Redis (status=pending, TTL 5min)
   - Build target list: merge linked approver chatIds + TELEGRAM_CHAT_ID env var
     (IMPORTANT: env var is ALWAYS included, not just as fallback)
   - Send Approve/Reject buttons to all targets
   - Write monitor:login:last telemetry
   - Return { attemptId, browserSecret, expiresAt }

2. Browser polls POST /api/v1/auth/login/status
   - Sends { attemptId, browserSecret }
   - Returns current state: pending | approved | rejected | expired

3. Any linked Telegram approver taps Approve or Reject
   → POST /api/v1/telegram/webhook (callback_query)
   → Verify callback `from.id` and chat against the stored linked binding
   → First valid decision wins via Redis Lua CAS
   → editTelegramMessageText reflects decision in chat

4. On approved: POST /api/v1/auth/verify
   - Browser sends { attemptId, browserSecret }
   - consumeApprovedAttempt: CAS pending→consumed (exactly once)
   - JWT minted, returned to browser
   - Browser stores JWT in sessionStorage

5. All subsequent admin API calls include: Authorization: Bearer <jwt>
```

### Telegram Approver Linking

```
Admin: Settings → Add Approver → enter username (optional) → Generate Link
  → POST /api/v1/telegram-approvers/link-token
  → Creates tg:link:<token> (TTL 15min, bound to expectedUsername)
  → Returns deep link: https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>

User clicks link in Telegram:
  → Bot receives /start <token> in a private chat
  → POST /api/v1/telegram/webhook (message update)
  → consumeLinkToken: atomically deletes key (prevents replay)
  → Checks private user/chat binding and expected username (when specified)
  → Stores tg:approver:<userId> with chatId, username, linkedAt
  → Bot replies: "Telegram approval access linked successfully."
```

### Fallback / Stale Approver Handling

If a Redis approver record exists but the bot cannot message that chatId (e.g. user never started the bot), the `TELEGRAM_CHAT_ID` env var is **always merged** into the target list — it is never skipped. This was the root cause of a production login outage that has been fixed.

### Password Reset / First Run

- Forgot Password: sends HMAC 6-digit code to Telegram → user enters code in browser → new password set atomically.
- First Run: if `admin:auth` key does not exist, login bootstraps from `ADMIN_PASSWORD` env var, then forces password change on first dashboard access.

---

## G. TELEGRAM

### 1. Admin Login Approval

Sent after correct username+password. Approve/Reject buttons use `callback_data: login_approve:<attemptId>` and `login_reject:<attemptId>`. First decision wins atomically.

### 2. Order Notifications

Sent to all chatIds when a new order is submitted. Approve/Reject buttons use `callback_data: order_approve:<orderId>` (and legacy `approve_<orderId>`). Approval from Telegram uses the same engine as dashboard approval — idempotent.

### 3. Approver Linking

Via `/start <token>` message in private chat. See section F.

### 4. Password Reset

6-digit code sent to Telegram. No buttons — code is entered back in the browser.

### Customer VPN Key Delivery via Telegram

**NOT IMPLEMENTED.** Do not implement unless explicitly requested.

---

## H. PERMANENT VPN KEY ARCHITECTURE

### Canonical URL Format

```
ssconf://outline-manager.vercel.app/k/<32-hex-token>#<URL-encoded-customer-name>
```

- `ssconf://` scheme tells Outline clients to fetch the JSON config via HTTPS.
- The encoded fragment is display metadata and is not transmitted to `/k/<token>`.
- Empty or missing names produce the same URL without a trailing `#`.
- Customer identity is always the token; changing a name affects only the fragment.

### What GET /k/<token> Returns

```json
{
  "method": "chacha20",
  "password": "...",
  "server": "1.2.3.4",
  "server_port": 12345
}
```

- Plain `text/plain` ss:// format is **not** returned (legacy, removed).
- Content-Type: `application/json; charset=utf-8`
- Cache-Control: `no-store`
- Unknown/disabled/expired/revoked tokens return empty **404** (indistinguishable).
- Redis failure returns **503** (never 404 — infra trouble ≠ token unknown).

### Why Vercel, Not workers.dev

The Cloudflare Worker at `workers.dev` was the original implementation. It passed browser fetch tests but **real Outline clients on macOS and iOS failed to connect** — the ssconf URL was not resolved correctly by the client application.

Moving to Vercel `/k/[token]` returning JSON fixed real-device connectivity. The Cloudflare Worker still exists and its KV namespace is still written to as a cache/projection layer, but it is not the customer-facing endpoint.

### Token Permanence

The 32-hex token (128 bits, cryptographically random) is generated once at identity creation and never changes. The `/k/<token>` path is stable; only the display-name fragment may change when a name changes. All of the following happen without changing the token:

- Quota changes
- Expiry changes
- Disable/enable cycles
- Underlying Outline key replacement (migration, reactivation)
- Server migration

---

## I. QUOTA / EXPIRY

### Configured Quota

`configuredQuotaBytes` in `DynamicCustomerRow` is the admin-set plan allowance. Always display this — never `remainingBytes` — as the customer's quota.

### 30-Day Cycle

- `periodStart` anchors the cycle to a fixed date.
- Rollover advances by exactly `periodStart + 30 days` (not from `now`).
- `carriedBytes` = usage on previous Outline keys in this period (for migration continuity).
- Cycle rollover costs **zero** Cloudflare KV writes (only Outline limit + Redis metadata change).

### Unlimited

`quotaBytes = null` means unlimited. `configuredQuotaBytes = null` in the customer row. Outline key must have **no data limit** set — removing the limit, not setting it to 0.

### Edit Subscription

Single dialog edits both quota GB and expiry date together. Submits `editSubscription` action to `/api/v1/dynamic-keys/actions`. Past expiry → disables immediately (`disabledImmediately: true` in response).

### Renew Button

Removed from UI. Do not re-add without explicit instruction.
Dormant backend/client renewal helpers remain for compatibility, but the active admin flow is Edit Subscription.

### Mid-Period Quota Change

If quota is raised mid-period, customer gets the difference credited. If lowered, current usage is checked and the key may be immediately exhausted. Logic in `lib/dynamic-lifecycle.ts` → `editSubscription`.

---

## J. DISABLE / ENABLE

**Disable** (`DISABLE_STRATEGY=limit`, default):
1. Set Outline key data limit to `DISABLE_BLOCK_BYTES` (must be 0).
2. Store `suspendedState: { previousLimitBytes, reason, keyRemoved: false }`.
3. Set status=disabled, bump rev.

**Disable** (`DISABLE_STRATEGY=remove`):
1. Delete the Outline key entirely.
2. Store `suspendedState: { previousLimitBytes, reason, keyRemoved: true }`.
3. Set status=disabled, bump rev.

**Enable**:
1. If key was removed: recreate it under the same token via `repointDynamicIdentity`.
2. Restore remaining quota (not full cycle allowance — only what was left).
3. Clear suspendedState, set status=active, bump rev.

Disabled/expired customers return **404** from `/k/`, not their config.

---

## K. MIGRATION

**Purpose**: Move a customer from one Outline server to another while preserving their permanent ssconf URL and current-period quota consumption.

**Flow**:
1. Create new key on destination server.
2. `repointDynamicIdentity`: atomic Lua script updates serverId+keyId+accessUrl+rev in Redis, maintains old key index for cleanup.
3. Write CF KV projection with new accessUrl (rev bumped → old cache invalidated).
4. Old key remains until admin runs `migrateCleanup` (Delete old key). `cleanupPending=true` until then.
5. `carriedBytes` is set to current usage so destination quota reflects consumption.

**Production status**: Only one physical Outline server is currently deployed. Real two-server migration has not been validated end-to-end in production. Unit tests cover the logic.

---

## L. DELETE CUSTOMER

See AGENTS.md for the mandatory order of operations.

Key implementation: `lib/delete-customer.ts`

What is preserved in Redis after deletion:
- `dyn:<token>` — tombstone with `status=revoked`, `accessUrl=""`, `name=""`, full history
- `outline_key_meta` field for this serverId+keyId — preserved for audit
- `outline_orders` array containing any linked order
- `orderclaim:*` records

What is removed:
- `dynidx:server:<serverId>:<keyId>` — reverse lookup (cleared by `revokeDynamicIdentity`)
- `dyn:cycle_due` and `dyn:expiry_due` entries (cleared)
- CF KV projection (best-effort, queued if CF unavailable)
- Actual Outline key on the VPN server

---

## M. MONITORING

### System Monitoring Page (Admin → Monitoring tab)

All checks run server-side via `GET /api/v1/monitor` and `GET /api/v1/monitor/outline`. 30-second server-side cache. Manual Refresh button. No auto-polling.

| Section | What is checked |
|---|---|
| Application | env, region, commit SHA |
| Dynamic Config | Probe `/k/0000...0000` → expect 404 (proves route + Redis live) |
| Upstash Redis | Ping latency, KV write budget, dirty queue, expiry/cycle due counts |
| Telegram | getMe latency, webhook status, linked approver count, login delivery telemetry |
| Cron | Last run time, duration, processed/failed counts, overdue detection |
| Outline Servers | Per-server: API latency, key counts, managed/unmanaged, missing keys, duplicate mappings, VPN TCP port reachability |

### Customer Diagnose

`POST /api/v1/monitor/diagnose` with `{ token }`. Returns 9 structured checks:
App record, Status, Permanent token, Dynamic /k config, Outline server API, Outline key exists, Key mapping, Quota state, Expiry state.

Never mutates anything.

### AWS Resource Metrics

Not implemented. The UI always displays "Not configured" without failing. Adding AWS credentials alone does not enable collection.

### Login Telemetry (monitor:login:last)

Written after every login attempt. Contains: challengeCreatedAt, recipientsAttempted, deliverSucceeded, deliverFailed, lastFailureCategory (sanitised — no chatIds, no tokens).

---

## N. CRON / BACKGROUND JOBS

### Schedule

- **Vercel cron** (vercel.json): `0 3 * * *` — daily at 03:00 UTC (Hobby plan limitation).
- **Cloudflare scheduled Worker** (`worker/src/cron.ts`): hourly — sends Bearer token to `POST /api/v1/cron/tick`. This is the primary schedule.
- Both call the same endpoint. The endpoint is idempotent.

### Authentication

`Authorization: Bearer <CRON_SECRET>` or `x-vercel-cron-signature: <CRON_SECRET>`.

### What Each Tick Does (in order)

1. `processExpiries(nowMs, 50)` — disable customers whose `dyn:expiry_due` score ≤ now.
2. `processCycleRollovers(nowMs, 50)` — advance 30-day cycle for customers whose `dyn:cycle_due` score ≤ now. **Zero** CF KV writes.
3. `drainDirtyDynamicRecords(25)` — retry any CF KV projections that previously failed.
4. `writeCronSummary(...)` — persist results to `monitor:cron:last` (TTL 25h).

Each pass is bounded (50/50/25 items) to stay within Vercel function timeout and CF KV write budget.

---

## O. ENVIRONMENT VARIABLES

**Never document values. Names only.**

### Admin / Auth — Required

| Variable | Status | Notes |
|---|---|---|
| `ADMIN_USERNAME` | Required | Bootstrap username; overridden by `admin:auth` once set |
| `ADMIN_PASSWORD` | Required (bootstrap) | Bootstrap password (min 8 chars); ignored once `admin:auth` exists |
| `JWT_SECRET` | Required | Min 32 chars; sign/verify admin session JWTs |

### Redis — Required (one pair)

| Variable | Status | Notes |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Required | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Required | Upstash REST token |
| `KV_REST_API_URL` | Optional | Vercel KV alternative to Upstash |
| `KV_REST_API_TOKEN` | Optional | Vercel KV alternative token |

### Telegram — Required for login approval

| Variable | Status | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Required | Bot token from @BotFather |
| `TELEGRAM_BOT_USERNAME` | Required for approver linking | Bot username without @; used only for deep-link generation |
| `TELEGRAM_CHAT_ID` | Optional for login when linked approvers exist; operationally recommended | Comma-separated private chatIds; always merged into login targets and currently used directly by password reset and order notifications |
| `TELEGRAM_WEBHOOK_SECRET` | Strongly recommended | Webhook HMAC verification secret (min 16 chars) |

### Dynamic Config / VPN Core

| Variable | Status | Notes |
|---|---|---|
| `DYNAMIC_KEY_BASE_URL` | Optional override | Defaults to `https://outline-manager.vercel.app`; any production override must remain canonical |
| `NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL` | Optional override | Same public canonical base for browser-side URL building |

### Cloudflare KV (projection cache)

| Variable | Status | Notes |
|---|---|---|
| `CF_ACCOUNT_ID` | Required for KV sync | Cloudflare account ID |
| `CF_KV_NAMESPACE_ID` | Required for KV sync | KV namespace ID |
| `CF_KV_API_TOKEN` | Required for KV sync | Scoped token: Workers KV Storage Edit only |

If absent, all KV writes are queued to `dyn:kv_dirty` and the cron will retry. The Vercel `/k/` route reads from Redis directly so customers are unaffected.

### Cron

| Variable | Status | Notes |
|---|---|---|
| `CRON_SECRET` | Required | Min 32 chars hex; authenticates `POST /api/v1/cron/tick` |

### VPN Disable Strategy

| Variable | Status | Notes |
|---|---|---|
| `DISABLE_STRATEGY` | Optional | `limit` (default) or `remove` |
| `DISABLE_BLOCK_BYTES` | Optional | Must be `0` under limit strategy |

### Vercel (auto-populated)

| Variable | Status | Notes |
|---|---|---|
| `VERCEL_URL` | Auto | Current deployment URL; used by monitoring for internal probes |
| `VERCEL_GIT_COMMIT_SHA` | Auto | Shown in monitoring app section |
| `VERCEL_REGION` | Auto | Shown in monitoring app section |

### AWS (reserved — resource collection not implemented)

| Variable | Status | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Optional | Not currently used; does not enable metrics by itself |
| `AWS_SECRET_ACCESS_KEY` | Optional | Not currently used; does not enable metrics by itself |
| `AWS_REGION` | Optional | Used as fallback region label in monitoring |

### Other

| Variable | Status | Notes |
|---|---|---|
| `LOG_LEVEL` | Optional | Pino log level; default `info` |
| `NODE_ENV` | Optional | `production` / `development` / `test` |

---

## P. DEPLOYMENT

### Normal Flow

```
Code changes → git commit → git push origin main
→ Vercel detects push → builds Next.js → deploys to production
→ outline-manager.vercel.app becomes live
→ Vercel production deployment URL visible in `vercel ls --prod`
```

### Production Domain

`https://outline-manager.vercel.app`

### Vercel Project

Team/project: `zwe-mann-heins-projects-391f0008 / outline-manager`

### Cloudflare Worker

The worker at `worker/` is deployed separately via `wrangler deploy`. It reads from CF KV. It is not required for production functionality (Vercel `/k/` is canonical) but should remain deployed for cache layer purposes. Do not modify or redeploy the worker as part of application changes unless explicitly asked.

### CI / GitHub Actions

`.github/workflows/ci.yml` runs on push to `main` or `develop`:
- `npm run lint`
- `npm run type-check`
- `npm run test` (vitest --run)
- `npm run build`

Vercel also runs the production build during deployment.

---

## Q. CURRENT PRODUCTION STATUS

Verified by the 2026-08-31 source reconciliation pass.

```
npm run type-check  → PASS (0 errors)
npm run test        → PASS (25 files, 452 tests)
npm run build       → PASS
```

### Implemented Features

- Single admin account with scrypt password auth
- Telegram two-factor login (any linked approver approves)
- Multiple Telegram approvers (linked via `/start` deep-link)
- Telegram approver management UI (Settings tab)
- Order submission (public page)
- Order approval/rejection (dashboard + Telegram)
- Customer list with search (client-side filter, debounced)
- Admin-created customers (new key or existing unmanaged key)
- Quota management (finite GB per 30 days, or Unlimited)
- Expiry date management
- Auto-disable on expiry (cron)
- Disable / Enable
- Edit Subscription (quota + expiry together)
- Server migration (preserves token)
- Delete Customer (safe, ordered, idempotent)
- Permanent ssconf:// URL on Vercel (`/k/<token>` → JSON)
- Cloudflare KV projection cache
- System Monitoring page (read-only, all services)
- Customer Diagnose (read-only, 9 checks)
- Cron job (expiry + cycle rollover + KV drain + telemetry)
- Login delivery telemetry
- Mobile-responsive dashboard (320px–desktop)
- Backfill tool (migrate existing Outline keys to managed customers)
- Forgot Password / Change Password

---

## R. KNOWN LIMITATIONS / UNFINISHED WORK

1. **AWS CPU/RAM/Disk/Network metrics**: Not implemented. Displays "Not configured"; credentials alone do not enable it. Do not fabricate.

2. **Customer Telegram delivery**: Intentionally not implemented. Do not add.

3. **Single physical Outline server**: Only one server is deployed in production. Server migration logic is unit-tested but has not been validated with two live servers simultaneously.

4. **Android Outline client**: Real-device ssconf connectivity was confirmed on macOS and iOS. Android compatibility is not documented as confirmed.

5. **Cycle UI hidden**: The underlying cycle/period state (cyclesTotal, cyclesUsed, periodStart) still exists in Redis and drives enforcement. It is intentionally hidden from the admin customer card UI. Do not re-expose without being asked.

6. **Worker cron separate deployment**: The Cloudflare Worker that calls `/api/v1/cron/tick` hourly must be deployed and scheduled separately via `wrangler`. If it is not deployed, the Vercel cron (daily at 03:00 UTC) is the only schedule — customers may wait up to 24 hours for expiry processing.

   The checked-in `ROLLOVER_URL` targets the canonical Vercel production endpoint. Worker deployment remains separate from Vercel deployment.

7. **Upstash free tier KV write limit**: 1,000 CF KV writes/day. Cycle rollovers cost 0 writes (by design). Bulk migrations or many simultaneous disable/enable operations could approach this limit.

---

## S. IMPORTANT HISTORICAL LESSONS

Do not repeat these mistakes.

1. **workers.dev ssconf failed real Outline clients.** The Cloudflare Worker at `workers.dev` passed browser `fetch()` tests but Outline clients on macOS and iOS could not connect. The Vercel `/k/[token]` JSON route fixed it. Never assume browser test = Outline client success.

2. **Plain-text `ss://` in `/k/` response broke clients.** Outline clients expect JSON format. Plain-text ss:// is legacy. The current route correctly returns JSON.

3. **Display names belong only in the outer fragment.** The current product format intentionally appends the URL-encoded customer name after `#`. Never place it in `/k/<token>`, use it as identity, or alter the Vercel resolver response.

4. **Telegram order success ≠ login approval success.** Order notifications and login approval use different paths. When login approval stopped working, order notifications continued working. Always check login delivery telemetry (`monitor:login:last`) separately.

5. **Stale Redis approver bypassed working env-var channel.** The bug: `chatIds = linkedChatIds.length > 0 ? linkedChatIds : staticIds`. A single stale approver record (bot returned "Not Found" for the chatId) caused `TELEGRAM_CHAT_ID` env var to be completely skipped. Fix: always merge both lists. Current code does this correctly — do not revert to the old conditional.

6. **Manual KV writes ≠ backend sync works.** Manually writing to CF KV does not prove the `/k/` Vercel route reads from Redis correctly, or that the Outline key exists, or that quota is enforced. Each layer must be verified independently.

7. **`configuredQuotaBytes` ≠ `remainingBytes`.** The UI previously briefly showed decreasing remaining quota as the plan quota. This is wrong. `configuredQuotaBytes` is always the plan allowance. `remainingBytes` is enforcement state. Do not confuse them.

8. **JS bundle text ≠ rendered UI.** A string in the JavaScript bundle does not prove a button is visible, clickable, or reachable on a real device at the specified breakpoint.

---

## T. SAFE DEBUGGING PLAYBOOK

### 1. Customer Cannot Connect

```
1. Dashboard → Customers → find customer → Diagnose
   - Check "Outline key exists" and "Dynamic /k config" checks
2. If /k returns 404 for active customer:
   - Check sync state (pending?) → use Resync button
   - Check monitor:cron:last for recent drain run
3. Reveal Raw Key (admin only) → confirm ss:// is valid format
4. Compare with another working customer on the same server
5. Check Outline key's data limit in server dashboard:
   - Unlimited customer should have NO limit set (not 0 bytes)
   - Finite customer should have correct limit
6. Check if server is reachable: Monitoring → Outline Servers
```

### 2. ssconf URL Fails

```
1. Open https://outline-manager.vercel.app/k/<token> in a browser
   - Expect 200 JSON with method/password/server/server_port
   - If 404: identity is disabled/revoked or KV stale
   - If 503: Redis is down
2. Import the raw ss:// key directly into Outline client
   - If ss:// works but ssconf doesn't: issue is in /k/ route or JSON format
   - If ss:// also fails: issue is in Outline server or key config
3. Confirm JSON format is correct (not plain-text ss://)
4. Check if token is 32 lowercase hex characters
```

### 3. Telegram Login Message Not Arriving

```
1. Dashboard → Monitoring → Telegram section
   - Check "Login Approval Telemetry" → recipientsAttempted, deliverSucceeded, deliverFailed
2. If deliverFailed > 0: check lastFailureCategory
   - "Not Found": bot cannot message that chatId (user never started bot / wrong ID)
   - "Forbidden": bot was blocked
3. Check linked approvers count in Telegram section
4. Check TELEGRAM_CHAT_ID env var is set in Vercel production settings
5. Verify bot is working: Monitoring → Telegram → Bot should show "Healthy"
6. To add a working approver: Settings → Telegram Approvers → Add Approver
   → send deep link to the Telegram user → they must click it and confirm
7. Note: TELEGRAM_CHAT_ID is ALWAYS included in notification list alongside
   dynamic approvers — both must be correct for reliable delivery
```

### 4. Cron Issue

```
1. Dashboard → Monitoring → Cron section
   - Check "Last run" timestamp
   - If > 2 hours ago: Cloudflare Worker cron may not be firing
   - If > 24 hours ago: both CF Worker and Vercel cron have failed
2. Manual test: POST /api/v1/cron/tick with Authorization: Bearer <CRON_SECRET>
   - Expect 200 JSON with expiry/rollover/drain reports
3. Check CF Worker status in Cloudflare dashboard
4. Verify CRON_SECRET is set in Vercel production and CF Worker environment
5. Check Redis dirty queue size in Monitoring → Redis section
   - High dirty queue = KV sync failing or cron not running drain step
```

---

## U. DO-NOT-BREAK CHECKLIST

Before shipping any change, verify none of these are broken:

- [ ] **One dashboard admin account** — no additional accounts created
- [ ] **Multiple Telegram approvers** — any number can be linked/unlinked
- [ ] **TELEGRAM_CHAT_ID always included** — not skipped when Redis approvers exist
- [ ] **Permanent Vercel ssconf URL** — stable `/k/<token>` path with optional encoded name fragment; resolver returns JSON 200 for active customers
- [ ] **Raw ss:// hidden** — never in API responses except audited `revealRaw` action
- [ ] **Quota period logic** — 30-day cycle, configured quota displayed (not remaining)
- [ ] **Expiry auto-disable** — past expiry disables immediately via Edit Sub or cron
- [ ] **Order history on customer deletion** — `outline_orders` untouched after delete
- [ ] **Customer/order compatibility** — existing approved orders still work
- [ ] **Mobile responsiveness** — 320px minimum, no horizontal overflow
- [ ] **Monitoring is read-only** — no state mutations from monitoring endpoints
- [ ] **Token permanence** — same ssconf URL survives quota/expiry/disable/enable/migrate
- [ ] **Unlimited = no Outline limit** — not 0 bytes, literally no data limit set
- [ ] **Type-check passes** — `npm run type-check` exits 0
- [ ] **Tests pass** — `npm run test` exits 0 (25 files, ≥452 tests)
- [ ] **Build passes** — `npm run build` exits 0
