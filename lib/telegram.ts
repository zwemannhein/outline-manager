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
 * Send approval confirmation with the customer's PERMANENT key.
 *
 * Carries the ssconf:// URL, never the raw ss:// access URL. The permanent URL is
 * what the customer needs, and it stays valid across server migration, quota
 * changes and renewal — so this message never goes stale.
 */
export async function sendApprovalConfirmation(
  config: TelegramConfig,
  order: {
    id: string;
    name: string;
    dynamicUrl: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const message: TelegramMessage = {
    chat_id: config.chatId,
    text:
      `✅ Order Approved\n\n` +
      `👤 Customer: ${order.name}\n` +
      `🔑 Permanent Key:\n\n${order.dynamicUrl}`,
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

// ── Admin authentication messages ─────────────────────────────────────────────

/**
 * Build the admin login approval message text.
 *
 * Exported separately so tests can assert exactly what is and is not included.
 * Deliberately carries NO password, JWT, browserSecret, or infrastructure
 * credential — only what the admin needs to judge the request.
 */
export function buildLoginApprovalText(params: {
  username: string;
  browserSummary: string;
  ip: string;
  requestedAt: number | Date;
}): string {
  const when =
    params.requestedAt instanceof Date
      ? params.requestedAt
      : new Date(params.requestedAt);

  return (
    `🔐 Admin Login Request\n\n` +
    `👤 Username: ${params.username}\n` +
    `🕐 Time: ${when.toLocaleString()}\n` +
    `💻 Browser: ${params.browserSummary}\n` +
    `🌐 IP: ${params.ip}\n\n` +
    `Approve this login?`
  );
}

/**
 * Send an admin login approval request with Approve / Reject buttons.
 *
 * callback_data uses the explicit `login_*` prefix so the shared webhook can
 * separate it from order callbacks.
 */
export async function sendLoginApprovalRequest(
  config: TelegramConfig,
  attempt: {
    attemptId: string;
    username: string;
    browserSummary: string;
    ip: string;
    requestedAt: number | Date;
  }
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const message: TelegramMessage = {
    chat_id: config.chatId,
    text: buildLoginApprovalText(attempt),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `login_approve:${attempt.attemptId}` },
          { text: "❌ Reject", callback_data: `login_reject:${attempt.attemptId}` },
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
 * Build the password reset message text.
 *
 * Includes the current admin USERNAME on purpose: Forgot Password must also
 * recover a forgotten username, and possession of the Telegram chat is the
 * authentication factor. Carries no password, hash, salt, or other secret.
 */
export function buildPasswordResetText(params: {
  username: string;
  code: string;
  expiresInMinutes: number;
}): string {
  return (
    `🔑 Password Reset Request\n\n` +
    `👤 Username: ${params.username}\n` +
    `🔢 Reset Code: ${params.code}\n` +
    `⏳ Expires in: ${params.expiresInMinutes} minutes\n\n` +
    `If you did not request this reset, ignore this message.`
  );
}

/**
 * Send the username + 6-digit reset code. No inline buttons: the code itself is
 * the proof, entered back in the browser.
 */
export async function sendPasswordResetCode(
  config: TelegramConfig,
  params: { username: string; code: string; expiresInMinutes: number }
): Promise<{ ok: boolean; error?: string }> {
  const message: TelegramMessage = {
    chat_id: config.chatId,
    text: buildPasswordResetText(params),
  };

  const result = await sendTelegramMessage(config.botToken, message);
  return { ok: result.ok, error: result.error };
}

/**
 * Notify that the admin password changed. Never includes the new password.
 */
export async function sendPasswordChangedNotice(
  config: TelegramConfig,
  params: { username: string; via: "dashboard" | "reset" }
): Promise<{ ok: boolean; error?: string }> {
  const how = params.via === "dashboard" ? "dashboard Change Password" : "Forgot Password reset";
  const message: TelegramMessage = {
    chat_id: config.chatId,
    text:
      `✅ Admin Password Changed\n\n` +
      `👤 Username: ${params.username}\n` +
      `🛠 Via: ${how}\n` +
      `🕐 Time: ${new Date().toLocaleString()}\n\n` +
      `If this was not you, reset the password immediately.`,
  };

  const result = await sendTelegramMessage(config.botToken, message);
  return { ok: result.ok, error: result.error };
}

/**
 * Edit an existing message's text, used to reflect an approve/reject decision.
 * Best-effort; failure is not surfaced to the caller as an error condition.
 */
export async function editTelegramMessageText(
  botToken: string,
  params: { chatId: string | number; messageId: number; text: string }
): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        message_id: params.messageId,
        text: params.text,
      }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
