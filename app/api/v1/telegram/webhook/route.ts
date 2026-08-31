/**
 * Telegram Bot Webhook Handler
 *
 * Single webhook for:
 *   1. /start <link-token>   — Telegram approver linking
 *   2. callback_query        — order approve/reject, login approve/reject
 *
 * SECURITY MODEL
 *  1. X-Telegram-Bot-Api-Secret-Token is verified against TELEGRAM_WEBHOOK_SECRET
 *     when that variable is configured.
 *  2. Linked callbacks require both the stored numeric user_id and chat binding.
 *     Legacy TELEGRAM_CHAT_ID callbacks require a private user_id === chat_id binding.
 *  3. The Telegram numeric user_id is the permanent security identity; username
 *     alone cannot authorize any action.
 *  4. New approver links must be completed in a private bot chat.
 *  5. No secrets, access URLs, or upstream error strings are logged or sent back.
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
import {
  consumeLinkToken,
  isValidLinkToken,
  linkApprover,
  listApprovers,
  authorizeTelegramCallback,
  isPrivateTelegramBinding,
} from "@/lib/telegram-approvers";
import { timingSafeEqual, createHash } from "crypto";

export const runtime = "nodejs";

const logger = createLogger("telegram-webhook");

// ── Telegram update shape ─────────────────────────────────────────────────────

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: TelegramUser;
    chat: { id: number; type: string };
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
  };
  callback_query?: {
    id: string;
    from: TelegramUser;
    message: { message_id: number; chat: { id: number; type?: string } };
    data: string;
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Length-independent timing-safe comparison. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

async function answerCallback(botToken: string, id: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch {
    /* best-effort */
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const staticChatId = process.env.TELEGRAM_CHAT_ID; // legacy static allowlist
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!botToken) {
      logger.error("Telegram bot is not configured; rejecting webhook delivery");
      return NextResponse.json({ ok: false, error: "Not configured" }, { status: 500 });
    }

    // ── 1. Verify the webhook secret token ──────────────────────────────────
    if (webhookSecret) {
      const provided = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!provided || !timingSafeEqualStr(provided, webhookSecret)) {
        logger.warn("Telegram webhook rejected: bad or missing secret token");
        return NextResponse.json({ ok: false }, { status: 403 });
      }
    } else {
      logger.warn(
        "TELEGRAM_WEBHOOK_SECRET is not configured — webhook authenticity cannot be verified."
      );
    }

    const update = (await req.json()) as TelegramUpdate;

    // ── 2. /start command — Telegram approver linking ────────────────────────
    if (update.message?.text != null) {
      const msg = update.message;
      const text = (msg.text ?? "").trim();
      // Accept /start <token>
      const startMatch = /^\/start(?:@\S+)?\s+([0-9a-f]{32})$/i.exec(text);
      if (startMatch) {
        return await handleStartLink({
          botToken,
          token: startMatch[1].toLowerCase(),
          from: msg.from,
          chatId: String(msg.chat.id),
          chatType: msg.chat.type,
        });
      }
      // Bare /start — acknowledge
      if (/^\/start(?:@\S+)?$/.test(text)) {
        await sendTelegramMessage(botToken, {
          chat_id: msg.chat.id,
          text: "👋 This bot manages Outline VPN admin approvals.\n\nUse the link generated in the admin dashboard to connect your account.",
        });
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ ok: true });
    }

    // ── 3. callback_query ────────────────────────────────────────────────────
    if (!update.callback_query) return NextResponse.json({ ok: true });
    const { callback_query } = update;

    // Authorize using Telegram's numeric user_id plus the verified chat binding.
    const approvers = await listApprovers();
    const staticIds = staticChatId
      ? staticChatId.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const incomingChatId = callback_query.message.chat.id.toString();
    const telegramUserId = String(callback_query.from.id);
    const authorization = authorizeTelegramCallback({
      approvers,
      staticChatIds: staticIds,
      telegramUserId,
      chatId: incomingChatId,
    });
    if (!authorization.authorized) {
      logger.warn(
        { reason: authorization.reason },
        "Telegram callback rejected: identity or chat binding mismatch"
      );
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 403 });
    }

    const allowedIds = Array.from(
      new Set([...approvers.map((approver) => approver.chatId), ...staticIds])
    );

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

// ── /start link handler ───────────────────────────────────────────────────────

async function handleStartLink(ctx: {
  botToken: string;
  token: string;
  from: TelegramUser;
  chatId: string;
  chatType: string;
}): Promise<NextResponse> {
  const { botToken, token, from, chatId, chatType } = ctx;

  if (!isPrivateTelegramBinding(chatType, String(from.id), chatId)) {
    await sendTelegramMessage(botToken, {
      chat_id: chatId,
      text: "❌ Approver linking must be completed in a private chat with this bot.",
    });
    logger.warn("Telegram approver link rejected: private chat binding required");
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  if (!isValidLinkToken(token)) {
    await sendTelegramMessage(botToken, {
      chat_id: chatId,
      text: "❌ This link is invalid.",
    });
    return NextResponse.json({ ok: false });
  }

  // Consume the token atomically.
  const link = await consumeLinkToken(token);

  if (!link) {
    await sendTelegramMessage(botToken, {
      chat_id: chatId,
      text: "❌ This link has expired or already been used. Please ask the admin to generate a new one.",
    });
    logger.warn("Telegram link token invalid, expired, or consumed");
    return NextResponse.json({ ok: false });
  }

  // Verify expected username if one was specified.
  const incomingUsername = (from.username ?? "").toLowerCase().trim();
  if (link.expectedUsername && incomingUsername !== link.expectedUsername) {
    await sendTelegramMessage(botToken, {
      chat_id: chatId,
      text:
        `❌ This link was generated for @${link.expectedUsername}, ` +
        `but you are logged in as ${from.username ? "@" + from.username : "a user without a username"}.\n\n` +
        `Please ask the admin to generate a new link for your account.`,
    });
    logger.warn("Telegram link username mismatch");
    return NextResponse.json({ ok: false });
  }

  // Link the approver using verified Telegram user_id as the permanent identity.
  await linkApprover({
    userId: String(from.id),
    chatId,
    username: from.username ?? "",
  });

  await sendTelegramMessage(botToken, {
    chat_id: chatId,
    text:
      "✅ Telegram approval access linked successfully.\n\n" +
      "You will now receive admin login approval requests here. " +
      "Tap Approve or Reject to respond.",
  });

  logger.info("Telegram approver linked via private /start flow");

  return NextResponse.json({ ok: true });
}

// ── Admin login approve / reject ──────────────────────────────────────────────

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

  // Reflect outcome in the message.
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
  allowedIds: string[];
  incomingChatId: string;
  callbackId: string;
  action: "approve" | "reject";
  orderId: string;
}): Promise<NextResponse> {
  const { botToken, allowedIds, incomingChatId, callbackId, action, orderId } = ctx;

  const order = await findOrder(orderId);
  if (!order) {
    await answerCallback(botToken, callbackId, "⚠️ Order not found");
    return NextResponse.json({ ok: false });
  }

  if (action === "reject") {
    const result = await rejectOrder(orderId);
    if (!result.ok) {
      await answerCallback(botToken, callbackId, `⚠️ ${result.message}`);
      return NextResponse.json({ ok: false });
    }
    // Notify all approvers.
    for (const id of allowedIds) {
      await sendRejectionConfirmation({ botToken, chatId: id }, { id: order.id, name: order.name }).catch(
        () => {}
      );
    }
    await answerCallback(botToken, callbackId, "❌ Order rejected!");
    logger.info({ orderId }, "Order rejected via Telegram");
    return NextResponse.json({ ok: true });
  }

  // Approve
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

    if (result.code !== "APPROVAL_IN_PROGRESS" && result.code !== "ALREADY_PROCESSED") {
      for (const id of allowedIds) {
        await sendTelegramMessage(botToken, {
          chat_id: id,
          text: `❌ Could not approve order for ${order.name}.\n${result.message}`,
        }).catch(() => {});
      }
    }

    logger.warn({ orderId, code: result.code }, "Telegram approval did not complete");
    return NextResponse.json({ ok: false });
  }

  if (result.reconciled) {
    await answerCallback(botToken, callbackId, "✅ Already approved");
    return NextResponse.json({ ok: true });
  }

  // Send confirmation to all approvers.
  for (const id of allowedIds) {
    await sendApprovalConfirmation(
      { botToken, chatId: id },
      { id: order.id, name: order.name, dynamicUrl: result.dynamicUrl }
    ).catch(() => {});
  }

  for (const id of allowedIds) {
    if (id !== incomingChatId) {
      await sendTelegramMessage(botToken, {
        chat_id: id,
        text: `✅ Order approved by another admin\n\n👤 Customer: ${order.name}`,
      }).catch(() => {});
    }
  }

  await answerCallback(botToken, callbackId, "✅ Approved!");

  if (result.syncPending) {
    for (const id of allowedIds) {
      await sendTelegramMessage(botToken, {
        chat_id: id,
        text:
          `⚠️ Key created for ${order.name}, but the edge config sync is pending.\n` +
          `It will retry automatically within the hour.`,
      }).catch(() => {});
    }
  }

  logger.info(
    { orderId, serverId: result.serverId, keyId: result.outlineKeyId },
    "Order approved via Telegram"
  );

  return NextResponse.json({ ok: true });
}
