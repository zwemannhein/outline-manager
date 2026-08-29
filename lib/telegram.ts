/**
 * Telegram Bot Integration
 * Sends order notifications and handles approval/rejection via Telegram
 */

export interface TelegramMessage {
  chat_id: string | number;
  text: string;
  parse_mode?: "Markdown" | "HTML";
  reply_markup?: {
    inline_keyboard: Array<Array<{
      text: string;
      callback_data: string;
    }>>;
  };
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/**
 * Send a message via Telegram Bot API
 */
export async function sendTelegramMessage(
  botToken: string,
  message: TelegramMessage
): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[Telegram] API error:", data);
      return { ok: false, error: data.description || "Failed to send message" };
    }

    return { ok: true, result: data.result };
  } catch (error) {
    console.error("[Telegram] Network error:", error);
    return { ok: false, error: error instanceof Error ? error.message : "Network error" };
  }
}

/**
 * Send order notification with approve/reject buttons (plain text, no Markdown)
 */
export async function sendOrderNotification(
  config: TelegramConfig,
  order: {
    id: string;
    name: string;
    kpayRef: string;
    plan: string;
    customDataLimitGB?: number;
    createdAt: number;
  }
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const planLabel =
    order.plan === "custom"
      ? `Custom (${order.customDataLimitGB || "?"}GB)`
      : order.plan === "plan_a"
      ? "Plan A"
      : order.plan === "plan_b"
      ? "Plan B"
      : order.plan.toUpperCase();

  const message: TelegramMessage = {
    chat_id: config.chatId,
    text:
      `🔔 New VPN Order\n\n` +
      `👤 Customer: ${order.name}\n` +
      `💳 KPay Ref: ${order.kpayRef}\n` +
      `📦 Plan: ${planLabel}\n` +
      `🕐 Time: ${new Date(order.createdAt).toLocaleString()}\n\n` +
      `Tap a button to approve or reject:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve_${order.id}` },
          { text: "❌ Reject", callback_data: `reject_${order.id}` },
        ],
      ],
    },
  };

  const result = await sendTelegramMessage(config.botToken, message);

  return {
    ok: result.ok,
    messageId: result.result?.message_id,
    error: result.error,
  };
}

/**
 * Send approval confirmation message
 */
export async function sendApprovalConfirmation(
  config: TelegramConfig,
  order: {
    id: string;
    name: string;
    accessUrl: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const message: TelegramMessage = {
    chat_id: config.chatId,
    text:
      `✅ Order Approved\n\n` +
      `👤 Customer: ${order.name}\n` +
      `🔑 Access Key:\n\n${order.accessUrl}`,
  };

  const result = await sendTelegramMessage(config.botToken, message);
  return { ok: result.ok, error: result.error };
}

/**
 * Send rejection confirmation message
 */
export async function sendRejectionConfirmation(
  config: TelegramConfig,
  order: {
    id: string;
    name: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const message: TelegramMessage = {
    chat_id: config.chatId,
    text: `❌ Order Rejected\n\n👤 Customer: ${order.name}`,
  };

  const result = await sendTelegramMessage(config.botToken, message);
  return { ok: result.ok, error: result.error };
}

/**
 * Validate Telegram bot token format
 */
export function isValidBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Validate Telegram chat ID format
 */
export function isValidChatId(chatId: string): boolean {
  return /^(@[A-Za-z0-9_]+|-?\d+)$/.test(chatId);
}
