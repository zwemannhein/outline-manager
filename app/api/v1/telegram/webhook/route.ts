/**
 * Telegram Bot Webhook Handler
 *
 * Receives callback_query updates from Telegram and dispatches them by
 * callback type. Order approve/reject is handled here today; login approve/
 * reject will be added by the admin-login-approval work and must reuse this
 * single webhook (Telegram allows only one webhook URL per bot).
 *
 * SECURITY MODEL
 *  1. X-Telegram-Bot-Api-Secret-Token is verified against TELEGRAM_WEBHOOK_SECRET
 *     when that variable is configured. Telegram sends this header on every
 *     delivery when the webhook was registered with a secret_token.
 *  2. The chat id in the payload is checked against TELEGRAM_CHAT_ID. This is a
 *     necessary but NOT sufficient control on its own, because the payload is
 *     attacker-controlled if the secret token is not configured.
 *  3. No secrets, access URLs, or upstream error strings are logged or sent to
 *     Telegram.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/api-utils";
import { serverCreateAccessKey, serverSetDataLimit } from "@/lib/outline-server";
import {
  sendApprovalConfirmation,
  sendRejectionConfirmation,
  sendTelegramMessage,
} from "@/lib/telegram";
import { createLogger } from "@/lib/logger";
import { parseCallbackData } from "@/lib/telegram-callback";
import { timingSafeEqual, createHash } from "crypto";
import type { Order, OutlineServer } from "@/lib/types";

export const runtime = "nodejs";

const logger = createLogger("telegram-webhook");

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; first_name: string };
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
}

interface AdminData {
  servers: OutlineServer[];
}

/** Length-independent timing-safe comparison. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const allowedChatId = process.env.TELEGRAM_CHAT_ID;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!botToken || !allowedChatId) {
      logger.error("Telegram bot is not configured; rejecting webhook delivery");
      return NextResponse.json({ ok: false, error: "Not configured" }, { status: 500 });
    }

    // ── 1. Verify the webhook secret token ──────────────────────────────────
    if (webhookSecret) {
      const provided = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!provided || !timingSafeEqualStr(provided, webhookSecret)) {
        logger.warn("Telegram webhook rejected: bad or missing secret token");
        // 403 with no detail; do not reveal whether the header was absent or wrong.
        return NextResponse.json({ ok: false }, { status: 403 });
      }
    } else {
      logger.warn(
        "TELEGRAM_WEBHOOK_SECRET is not configured — webhook authenticity cannot be verified. " +
          "Set it and re-register the webhook with secret_token to enable verification."
      );
    }

    const update = (await req.json()) as TelegramUpdate;
    if (!update.callback_query) return NextResponse.json({ ok: true });

    const { callback_query } = update;

    // ── 2. Check the chat allow-list ────────────────────────────────────────
    const allowedIds = allowedChatId.split(",").map((id) => id.trim()).filter(Boolean);
    const incomingChatId = callback_query.message.chat.id.toString();
    if (!allowedIds.includes(incomingChatId)) {
      logger.warn("Telegram webhook rejected: chat id not in allow-list");
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 403 });
    }

    // ── 3. Dispatch by callback type ────────────────────────────────────────
    const parsed = parseCallbackData(callback_query.data);

    if (parsed.kind === "login") {
      // Admin-login approval is not implemented yet. Answer the callback so the
      // Telegram client does not spin, and take no action.
      logger.warn("Received a login callback but login approval is not enabled");
      await answerCallback(botToken, callback_query.id, "⚠️ Login approval not enabled");
      return NextResponse.json({ ok: true });
    }

    if (parsed.kind === "unknown") {
      await answerCallback(botToken, callback_query.id, "⚠️ Unknown action");
      return NextResponse.json({ ok: false });
    }

    return await handleOrderCallback({
      botToken,
      allowedChatId,
      allowedIds,
      incomingChatId,
      callbackId: callback_query.id,
      action: parsed.action,
      orderId: parsed.id,
    });
  } catch (error) {
    logger.error({ error }, "Telegram webhook handler failed");
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

// ── Order approve / reject ────────────────────────────────────────────────────

async function handleOrderCallback(ctx: {
  botToken: string;
  allowedChatId: string;
  allowedIds: string[];
  incomingChatId: string;
  callbackId: string;
  action: "approve" | "reject";
  orderId: string;
}): Promise<NextResponse> {
  const { botToken, allowedChatId, allowedIds, incomingChatId, callbackId, action, orderId } = ctx;

  const redis = getRedis();
  const orders = (await redis.get<Order[]>("outline_orders")) ?? [];
  const order = orders.find((o) => o.id === orderId);

  if (!order) {
    await answerCallback(botToken, callbackId, "⚠️ Order not found");
    return NextResponse.json({ ok: false });
  }
  if (order.status !== "pending") {
    await answerCallback(botToken, callbackId, "⚠️ Already processed");
    return NextResponse.json({ ok: false });
  }

  // ── REJECT ──────────────────────────────────────────────────────────────────
  if (action === "reject") {
    order.status = "rejected";
    (order as any).processedAt = Date.now();
    await redis.set("outline_orders", orders);
    await sendRejectionConfirmation(
      { botToken, chatId: allowedChatId },
      { id: order.id, name: order.name }
    );
    await answerCallback(botToken, callbackId, "❌ Order rejected!");
    logger.info({ orderId }, "Order rejected via Telegram");
    return NextResponse.json({ ok: true });
  }

  // ── APPROVE ─────────────────────────────────────────────────────────────────
  const rawAdmin = await redis.get<AdminData | string>("outline_admin_data");
  let adminData: AdminData | null = null;
  if (typeof rawAdmin === "string") {
    try {
      adminData = JSON.parse(rawAdmin);
    } catch {
      /* ignore malformed blob */
    }
  } else {
    adminData = rawAdmin;
  }

  const servers = adminData?.servers ?? [];
  if (servers.length === 0) {
    await answerCallback(botToken, callbackId, "❌ No servers configured!");
    await sendTelegramMessage(botToken, {
      chat_id: allowedChatId,
      text: "❌ No servers configured. Add one in the admin dashboard.",
    });
    return NextResponse.json({ ok: false });
  }

  const targetServer: OutlineServer =
    (order.serverId ? servers.find((s) => s.id === order.serverId) : undefined) ?? servers[0];

  try {
    const key = await serverCreateAccessKey(
      targetServer.apiUrl,
      targetServer.certSha256,
      order.name
    );

    const dataLimitBytes = getPlanBytes(order.plan, order.customDataLimitGB);
    if (dataLimitBytes) {
      await serverSetDataLimit(
        targetServer.apiUrl,
        targetServer.certSha256,
        key.id,
        dataLimitBytes
      );
    }

    order.status = "approved";
    order.accessUrl = key.accessUrl;
    order.serverId = targetServer.id;
    order.keyId = key.id;
    (order as any).processedAt = Date.now();
    await redis.set("outline_orders", orders);

    await sendApprovalConfirmation(
      { botToken, chatId: allowedChatId },
      { id: order.id, name: order.name, accessUrl: key.accessUrl }
    );

    for (const adminId of allowedIds) {
      if (adminId !== incomingChatId) {
        await sendTelegramMessage(botToken, {
          chat_id: adminId,
          text: `✅ Order approved by another admin\n\n👤 Customer: ${order.name}\n🔑 Key created on: ${targetServer.name}`,
        });
      }
    }

    await answerCallback(botToken, callbackId, "✅ Approved!");
    // serverId is safe to log; apiUrl/certSha256/accessUrl are not.
    logger.info(
      { orderId, serverId: targetServer.id, keyId: key.id },
      "Order approved via Telegram"
    );
  } catch (error) {
    // The upstream error message can contain the Outline management URL.
    // Log it through the redacting logger and never forward it to Telegram.
    logger.error({ error, orderId, serverId: targetServer.id }, "Key creation failed");
    await answerCallback(botToken, callbackId, "❌ Failed to create key");
    await sendTelegramMessage(botToken, {
      chat_id: allowedChatId,
      text: `❌ Failed to create key for ${order.name}. Check the server logs for details.`,
    });
  }

  return NextResponse.json({ ok: true });
}

async function answerCallback(botToken: string, id: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch {
    /* ignore — answering the callback is best-effort */
  }
}

function getPlanBytes(plan: string, customGB?: number | null): number | null {
  if (plan === "custom" && customGB) return customGB * 1024 * 1024 * 1024;
  const map: Record<string, number> = {
    plan_b: 100 * 1024 * 1024 * 1024,
    "10gb": 10 * 1024 * 1024 * 1024,
    "20gb": 20 * 1024 * 1024 * 1024,
    "50gb": 50 * 1024 * 1024 * 1024,
    "100gb": 100 * 1024 * 1024 * 1024,
  };
  return map[plan] ?? null; // plan_a = null = unlimited
}
