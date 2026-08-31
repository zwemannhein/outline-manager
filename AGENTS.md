# AGENTS.md — Operating Instructions for Codex

Read this file completely before making any change to this repository.

---

## PROJECT PURPOSE

This is an **Outline VPN subscription and customer management application** deployed on Vercel.

The admin dashboard allows a single administrator to:

- Manage Outline VPN servers and access keys
- Create and manage customer subscriptions (quota, expiry, enable/disable)
- Approve or reject customer orders
- Monitor system health (Redis, Telegram, Cron, Outline servers, dynamic config)
- Diagnose individual customer issues
- Delete customers safely
- Manage Telegram approvers for login security

---

## CRITICAL ARCHITECTURAL RULES

### One Dashboard Admin Account

- There is **exactly ONE** dashboard admin account.
- Do not add multiple admin accounts, admin roles, or admin creation flows.
- The single admin's credentials live in `admin:auth` in Redis (or bootstrap from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars).

### Telegram Approvers Are NOT Dashboard Accounts

- Telegram approvers can only Approve/Reject admin login requests via Telegram.
- They have no dashboard password, no JWT, and no access to the admin UI.
- Any number of approvers may be linked (including zero — env var fallback is used).
- Authorization requires the verified numeric **Telegram `user_id`** and its stored `chat_id` binding — never username alone.
- The `/start <token>` Telegram linking flow in a private bot chat is the only safe way to register an approver.

### Permanent Customer Key Rules

- Every customer receives a **permanent** ssconf URL:
  ```
  ssconf://outline-manager.vercel.app/k/<32-hex-token>
  ```
- The token **must never change** across: quota edits, expiry changes, disable/enable, renewal, migration, or Outline key replacement.
- Do **not** append `#customer-name` fragments to newly generated permanent keys.
- `GET /k/<token>` returns Outline-compatible JSON — `method`, `password`, `server`, `server_port`.
- Do **not** return plain-text `ss://` from `/k/`. That format is legacy.
- Raw `ss://` is admin troubleshooting only (audited, never shown by default).

### Canonical ssconf Endpoint Is Vercel — NOT workers.dev

- The live `/k/[token]` route is at `app/k/[token]/route.ts` (Next.js, Vercel).
- The Cloudflare Worker (`worker/`) also implements this route but is **not the canonical customer endpoint**.
- Historical lesson: the workers.dev route passed browser tests but **failed real Outline clients**. The Vercel JSON route works on macOS and iOS.
- Do not switch permanent keys back to workers.dev without explicit request and real-device verification.
- The Cloudflare Worker/KV code still exists and is used as a **public projection/cache** layer — not as the primary resolution path.

---

## DATA AND LIFECYCLE RULES

### Quota Display

- `configuredQuotaBytes` is the **admin-set plan allowance** — show this in the UI.
- `remainingBytes` is an enforcement value — do not show it as the configured quota.
- Example: plan = 120 GB, used = 20 MB → display "120 GB quota", not "119.98 GB".
- Unlimited customers must never accidentally receive a non-zero Outline data limit.

### Quota Period

- Quota resets every **30 days** from the period anchor.
- Finite quota = X GB per 30-day cycle.
- Multi-cycle plan = X GB per cycle for N cycles (not N×X GB pool).

### Expiry

- Expiry date is the subscription end date.
- Past expiry → cron disables the customer automatically.
- Past expiry entered in Edit Subscription → disables immediately.
- Future expiry → customer remains active.

### Edit Subscription

- Edits both quota and expiry together.
- The **Renew** button has been removed from the UI. Do not re-add it.
- Dormant/internal renewal helpers may remain for compatibility; they are not an active admin UI flow.

### Disable/Enable

- Disable: sets Outline data limit to 0 (default strategy) or deletes the key (remove strategy), marks identity `disabled`, bumps `rev` so edge cache invalidates.
- Enable: restores remaining quota (not full allowance), re-creates key if it was removed.
- Disabled/expired customers must return 404 from `/k/`.

---

## DELETE CUSTOMER RULES

Order of operations (do not change):

1. Revoke dynamic identity first (`status=revoked`, `rev++`, `accessUrl=""`, `name=""`) — makes `/k/` return 404 immediately.
2. Remove Cloudflare KV projection (best-effort; dirty queue handles retry).
3. Delete underlying Outline key from server.
4. If Outline deletion fails → return `OUTLINE_DELETE_FAILED` (identity already revoked, no orphan access).

Additional rules:

- Idempotent: already-revoked record → return `ok` immediately.
- Migration guard: if `pendingCleanupEntries.length > 0` → refuse with `MIGRATION_IN_PROGRESS`.
- **Always preserve**: order records, key-meta hash, identity tombstone in Redis, orderclaim records.
- Do not affect any other customer's records.

---

## MIGRATION RULES

- Migration must preserve the permanent ssconf URL (token stays identical).
- Carries current-period usage bytes to the destination so quota is not reset.
- Do not delete the source key before edge sync of the destination is confirmed.
- `cleanupPending = true` after migration until the old key is explicitly cleaned up.
- Note: only one physical Outline server is currently configured in production. Real multi-server migration has not been validated end-to-end in production.

---

## MONITORING RULES

- System Monitoring is **READ-ONLY**. It never mutates customer, Outline, or auth state.
- Do not add auto-repair actions without explicit request.
- AWS/Lightsail resource metrics (CPU/RAM/Disk/Network) are **not implemented** — display "Not configured".
- Adding AWS credentials alone does not enable resource metrics.
- Do not fabricate resource metrics.
- `not_configured` status must never make the overall system health Critical.
- All health checks run with `Promise.allSettled` — one failing service must not block others.
- 30-second server-side cache; manual Refresh button only. No automatic polling.

---

## SECURITY RULES

**Never** print, log, commit, or surface to the browser:

- Admin password or hash
- JWT secret
- Telegram bot token
- Telegram chat IDs or user IDs (except as sanitised aggregate counts in monitoring)
- Upstash/KV tokens
- Outline management API credentials (these contain a secret path segment)
- Raw `ss://` access URLs (admin troubleshooting only, audited)
- Cloudflare API tokens
- AWS credentials
- Dynamic customer tokens (except to the authenticated admin for copy-key)

Environment variable **names** are safe to document. Values are never safe to commit.

Do not write temporary secret files to disk. Use `vercel env pull` only for local dev, never commit the pulled file.

---

## CODE CHANGE RULES

Before any modification:

1. Read the relevant source files — do not assume from memory.
2. Check `git status` and `git diff` to understand current state.
3. Reuse existing helpers — do not duplicate Redis, auth, Outline, or lifecycle implementations.
4. After changes, run in order:
   ```
   npm run type-check
   npm run test
   npm run build
   ```
5. Fix all type errors and failing tests before committing.
6. Do not claim a UI feature works based only on source code — rendered behavior matters.
7. Do not claim VPN connectivity works based only on unit tests — real Outline client behavior matters.
8. Keep changes focused. Do not refactor unrelated code while fixing a bug.

---

## CUSTOMER TELEGRAM DELIVERY — NOT IMPLEMENTED

Customer VPN key delivery through Telegram is **intentionally not implemented**.

Do not implement it unless explicitly requested. Do not add customer Telegram linking, customer notifications, or VPN key Telegram delivery as a side-effect of other work.

---

## QUICK REFERENCE: IMPORTANT FILE PATHS

| Purpose | Path |
|---|---|
| Permanent /k/ route | `app/k/[token]/route.ts` |
| Cron tick | `app/api/v1/cron/tick/route.ts` |
| Admin login step 1 | `app/api/v1/auth/login/route.ts` |
| Telegram webhook | `app/api/v1/telegram/webhook/route.ts` |
| Dynamic key lifecycle | `lib/dynamic-lifecycle.ts` |
| Customer deletion | `lib/delete-customer.ts` |
| Monitoring helpers | `lib/monitoring.ts` |
| Telegram approvers | `lib/telegram-approvers.ts` |
| Validation schemas | `lib/validation.ts` |
| Redis key constants | `lib/dynamic-keys.ts`, `lib/order-approval.ts` |
