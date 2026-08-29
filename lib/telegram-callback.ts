/**
 * Telegram callback_data parsing.
 *
 * Lives outside the route file because Next.js route modules may only export
 * recognised HTTP handlers and route config, not helper functions.
 *
 * A single Telegram bot supports only one webhook URL, so order callbacks and
 * admin-login callbacks must share /api/v1/telegram/webhook. They are kept
 * apart by an explicit type prefix rather than by guessing from the payload.
 */

export type CallbackAction =
  | { kind: "order"; action: "approve" | "reject"; id: string }
  | { kind: "login"; action: "approve" | "reject"; id: string }
  | { kind: "unknown" };

/**
 * Supported formats:
 *   order_approve:<orderId>    order_reject:<orderId>     (current)
 *   login_approve:<attemptId>  login_reject:<attemptId>   (reserved)
 *   approve_<orderId>          reject_<orderId>           (legacy)
 *
 * The legacy underscore format is still accepted because approve/reject buttons
 * from previously delivered messages remain live in the admin chat history.
 * Telegram limits callback_data to 64 bytes; all four current prefixes plus a
 * 32-hex id or an `ord_<ms>_<16hex>` id stay within that budget.
 */
export function parseCallbackData(data: string): CallbackAction {
  if (!data) return { kind: "unknown" };

  const colon = data.indexOf(":");
  if (colon > 0) {
    const prefix = data.slice(0, colon);
    const id = data.slice(colon + 1);
    if (!id) return { kind: "unknown" };

    switch (prefix) {
      case "order_approve":
        return { kind: "order", action: "approve", id };
      case "order_reject":
        return { kind: "order", action: "reject", id };
      case "login_approve":
        return { kind: "login", action: "approve", id };
      case "login_reject":
        return { kind: "login", action: "reject", id };
      default:
        return { kind: "unknown" };
    }
  }

  // Legacy underscore format: "approve_<orderId>" / "reject_<orderId>".
  const firstUnderscore = data.indexOf("_");
  if (firstUnderscore > 0) {
    const action = data.slice(0, firstUnderscore);
    const id = data.slice(firstUnderscore + 1);
    if (id && (action === "approve" || action === "reject")) {
      return { kind: "order", action, id };
    }
  }

  return { kind: "unknown" };
}
