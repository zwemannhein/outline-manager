/**
 * Telegram Bot Webhook Handler
 * Receives approve/reject callbacks from Telegram
 * Server is chosen by the user during order — no extra step needed
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/api-utils";
import { serverCreateAccessKey, serverSetDataLimit } from "@/lib/outline-server";
import { sendApprovalConfirmation, sendRejectionConfirmation, sendTelegramMessage } from "@/lib/telegram";
import type { Order, OutlineServer } from "@/lib/types";

export const runtime = "nodejs";

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

export async function POST(req: NextRequest) {
  try {
    const update = (await req.json()) as TelegramUpdate;
    if (!update.callback_query) return NextResponse.json({ ok: true });

    const { callback_query } = update;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const allowedChatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !allowedChatId) {
      return NextResponse.json({ ok: false, error: "Bot not configured" }, { status: 500 });
    }

    // Only allow from authorized chats (supports multiple IDs comma-separated)
    const allowedIds = allowedChatId.split(",").map((id) => id.trim());
    if (!allowedIds.includes(callback_query.message.chat.id.toString())) {
      console.warn(`[Telegram] Unauthorized chat: ${callback_query.message.chat.id}`);
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 403 });
    }

    // callback_data format: "approve_ord_TIMESTAMP_RANDOM" or "reject_ord_TIMESTAMP_RANDOM"
    const firstUnderscore = callback_query.data.indexOf("_");
    const action = callback_query.data.slice(0, firstUnderscore);           // "approve" | "reject"
    const orderId = callback_query.data.slice(firstUnderscore + 1);         // "ord_1234_abc"

    if (!["approve", "reject"].includes(action)) {
      await answerCallback(botToken, callback_query.id, "⚠️ Unknown action");
      return NextResponse.json({ ok: false });
    }

    const redis = getRedis();
    const orders = (await redis.get<Order[]>("outline_orders")) ?? [];
    const order = orders.find((o) => o.id === orderId);

    if (!order) {
      await answerCallback(botToken, callback_query.id, "⚠️ Order not found");
      return NextResponse.json({ ok: false });
    }
    if (order.status !== "pending") {
      await answerCallback(botToken, callback_query.id, "⚠️ Already processed");
      return NextResponse.json({ ok: false });
    }

    // ── REJECT ────────────────────────────────────────────────────────────────
    if (action === "reject") {
      order.status = "rejected";
      (order as any).processedAt = Date.now();
      await redis.set("outline_orders", orders);
      await sendRejectionConfirmation({ botToken, chatId: allowedChatId }, { id: order.id, name: order.name });
      await answerCallback(botToken, callback_query.id, "❌ Order rejected!");
      return NextResponse.json({ ok: true });
    }

    // ── APPROVE ───────────────────────────────────────────────────────────────
    const rawAdmin = await redis.get<AdminData | string>("outline_admin_data");
    let adminData: AdminData | null = null;
    if (typeof rawAdmin === "string") {
      try { adminData = JSON.parse(rawAdmin); } catch { /* ignore */ }
    } else {
      adminData = rawAdmin;
    }

    const servers = adminData?.servers ?? [];
    if (servers.length === 0) {
      await answerCallback(botToken, callback_query.id, "❌ No servers configured!");
      await sendTelegramMessage(botToken, {
        chat_id: allowedChatId,
        text: "❌ No servers configured. Add one at https://outline-manager.vercel.app",
      });
      return NextResponse.json({ ok: false });
    }

    // Use server chosen by user during order, fallback to first server
    const targetServer: OutlineServer =
      (order.serverId ? servers.find((s) => s.id === order.serverId) : undefined)
      ?? servers[0];

    try {
      const key = await serverCreateAccessKey(targetServer.apiUrl, targetServer.certSha256, order.name);

      const dataLimitBytes = getPlanBytes(order.plan, order.customDataLimitGB);
      if (dataLimitBytes) {
        await serverSetDataLimit(targetServer.apiUrl, targetServer.certSha256, key.id, dataLimitBytes);
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
      // Notify all admins
      const allowedIds = allowedChatId.split(",").map((id) => id.trim());
      for (const adminId of allowedIds) {
        if (adminId !== callback_query.message.chat.id.toString()) {
          await sendTelegramMessage(botToken, {
            chat_id: adminId,
            text: `✅ Order approved by another admin\n\n👤 Customer: ${order.name}\n🔑 Key created on: ${targetServer.name}`,
          });
        }
      }
      await answerCallback(botToken, callback_query.id, "✅ Approved!");
      console.log(`[Telegram] Approved order ${orderId} on server: ${targetServer.name}`);
    } catch (err) {
      console.error("[Telegram] Key creation failed:", err);
      await answerCallback(botToken, callback_query.id, "❌ Failed to create key");
      await sendTelegramMessage(botToken, {
        chat_id: allowedChatId,
        text: `❌ Failed to create key for ${order.name}\nError: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Telegram Webhook] Error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

async function answerCallback(botToken: string, id: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch { /* ignore */ }
}

function getPlanBytes(plan: string, customGB?: number | null): number | null {
  if (plan === "custom" && customGB) return customGB * 1024 * 1024 * 1024;
  const map: Record<string, number> = {
    "plan_b":  100 * 1024 * 1024 * 1024,
    "10gb":     10 * 1024 * 1024 * 1024,
    "20gb":     20 * 1024 * 1024 * 1024,
    "50gb":     50 * 1024 * 1024 * 1024,
    "100gb":   100 * 1024 * 1024 * 1024,
  };
  return map[plan] ?? null; // plan_a = null = unlimited
}
