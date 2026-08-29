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
import { approveOrder, rejectOrder, findOrder } from "@/lib/order-approval";
import {
  sendApprovalConfirmation,
  sendRejectionConfirmation,
  sendTelegramMessage,
  editTelegramMessageText,
} from "@/lib/telegram";
import { createLogger, maskId } from "@/lib/logger";
import { parseCallbackData } from "@/lib/telegram-callback";
import {
  approveLoginAttempt,
  rejectLoginAttempt,
  getAttemptView,
  isValidAttemptId,
} from "@/lib/login-attempts";
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
      return await handleLoginCallback({
        botToken,
        callbackId: callback_query.id,
        chatId: incomingChatId,
        messageId: callback_query.message.message_id,
        action: parsed.action,
        attemptId: parsed.id,
      });
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

// ── Admin login approve / reject ──────────────────────────────────────────────

/**
 * Handle a login_approve / login_reject callback.
 *
 * Records the decision atomically. Deliberately does NOT issue or transmit a
 * JWT: the original browser must still return with its browserSecret, so
 * approving here is not by itself enough to obtain a session.
 */
async function handleLoginCallback(ctx: {
  botToken: string;
  callbackId: string;
  chatId: string;
  messageId: number;
  action: "approve" | "reject";
  attemptId: string;
}): Promise<NextResponse> {
  const { botToken, callbackId, chatId, messageId, action, attemptId } = ctx;

  if (!isValidAttemptId(attemptId)) {
    await answerCallback(botToken, callbackId, "⚠️ Invalid login request");
    return NextResponse.json({ ok: false });
  }

  const view = await getAttemptView(attemptId);
  if (!view) {
    await answerCallback(botToken, callbackId, "⚠️ Login request not found or expired");
    return NextResponse.json({ ok: false });
  }

  const result =
    action === "approve"
      ? await approveLoginAttempt(attemptId)
      : await rejectLoginAttempt(attemptId);

  if (!result.ok) {
    // Repeated taps are idempotent and report the settled state.
    const label =
      result.reason === "expired"
        ? "⚠️ This login request expired"
        : result.reason === "not_found"
          ? "⚠️ Login request not found"
          : `⚠️ Already ${result.status}`;
    await answerCallback(botToken, callbackId, label);
    logger.info({ attempt: maskId(attemptId), reason: result.reason }, "Login decision ignored");
    return NextResponse.json({ ok: true });
  }

  const approved = action === "approve";

  await answerCallback(botToken, callbackId, approved ? "✅ Login approved!" : "❌ Login rejected!");

  // Best-effort: reflect the outcome in the message so the chat shows history.
  await editTelegramMessageText(botToken, {
    chatId,
    messageId,
    text:
      (approved ? "✅ Login Approved\n\n" : "❌ Login Rejected\n\n") +
      `👤 Username: ${view.username}\n` +
      `🕐 Requested: ${view.createdAt ? new Date(view.createdAt).toLocaleString() : "unknown"}\n` +
      `💻 Browser: ${view.userAgent}\n` +
      `🌐 IP: ${view.ip}`,
  });

  logger.info({ attempt: maskId(attemptId), approved }, "Admin login decision recorded");

  return NextResponse.json({ ok: true });
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

  const order = await findOrder(orderId);
  if (!order) {
    await answerCallback(botToken, callbackId, "⚠️ Order not found");
    return NextResponse.json({ ok: false });
  }

  // ── REJECT ──────────────────────────────────────────────────────────────────
  if (action === "reject") {
    const result = await rejectOrder(orderId);
    if (!result.ok) {
      await answerCallback(botToken, callbackId, `⚠️ ${result.message}`);
      return NextResponse.json({ ok: false });
    }

    await sendRejectionConfirmation(
      { botToken, chatId: allowedChatId },
      { id: order.id, name: order.name }
    );
    await answerCallback(botToken, callbackId, "❌ Order rejected!");
    logger.info({ orderId }, "Order rejected via Telegram");
    return NextResponse.json({ ok: true });
  }

  // ── APPROVE ─────────────────────────────────────────────────────────────────
  // Delegates to the SAME engine the dashboard uses, so a Telegram tap racing a
  // dashboard click cannot produce two Outline keys, and a duplicate tap is a
  // no-op that reports the existing permanent key.
  const result = await approveOrder({ orderId, source: "telegram" });

  if (!result.ok) {
    const friendly =
      result.code === "APPROVAL_IN_PROGRESS"
        ? "⏳ Already being approved"
        : result.code === "ALREADY_PROCESSED"
          ? "⚠️ Already processed"
          : result.code === "NEEDS_RECONCILIATION"
            ? "⚠️ Needs manual review"
            : result.code === "NO_SERVERS"
              ? "❌ No servers configured"
              : "❌ Failed to create key";

    await answerCallback(botToken, callbackId, friendly);

    // Only escalate genuine failures into the chat, not benign double-taps.
    if (result.code !== "APPROVAL_IN_PROGRESS" && result.code !== "ALREADY_PROCESSED") {
      await sendTelegramMessage(botToken, {
        chat_id: allowedChatId,
        text: `❌ Could not approve order for ${order.name}.\n${result.message}`,
      });
    }

    logger.warn({ orderId, code: result.code }, "Telegram approval did not complete");
    return NextResponse.json({ ok: false });
  }

  if (result.reconciled) {
    // A previous attempt had already created everything.
    await answerCallback(botToken, callbackId, "✅ Already approved");
    return NextResponse.json({ ok: true });
  }

  await sendApprovalConfirmation(
    { botToken, chatId: allowedChatId },
    { id: order.id, name: order.name, dynamicUrl: result.dynamicUrl }
  );

  for (const adminId of allowedIds) {
    if (adminId !== incomingChatId) {
      await sendTelegramMessage(botToken, {
        chat_id: adminId,
        text: `✅ Order approved by another admin\n\n👤 Customer: ${order.name}`,
      });
    }
  }

  await answerCallback(botToken, callbackId, "✅ Approved!");

  if (result.syncPending) {
    await sendTelegramMessage(botToken, {
      chat_id: allowedChatId,
      text:
        `⚠️ Key created for ${order.name}, but the edge config sync is pending.\n` +
        `It will retry automatically within the hour.`,
    });
  }

  logger.info(
    { orderId, serverId: result.serverId, keyId: result.outlineKeyId },
    "Order approved via Telegram"
  );

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
