/**
 * GET  /api/v1/orders — List all orders (admin only)
 * POST /api/v1/orders — Submit a new order (public, rate-limited)
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getRedis,
  checkAuth,
  parseJsonBody,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  checkRateLimit,
  rateLimitResponse,
  getClientIp,
  AppError,
} from "@/lib/api-utils";
import { createOrderSchema } from "@/lib/validation";
import { createLogger } from "@/lib/logger";
import { sendOrderNotification } from "@/lib/telegram";
import { issueClaimToken } from "@/lib/order-claim";
import { randomBytes } from "crypto";
import type { Order } from "@/lib/types";

const logger = createLogger("orders");
const ORDERS_KEY = "outline_orders";

/**
 * Order id. Uses crypto randomness rather than Math.random so the identifier
 * is not predictable from the creation timestamp.
 */
function generateOrderId(): string {
  return "ord_" + Date.now() + "_" + randomBytes(8).toString("hex");
}

async function loadOrders(redis: ReturnType<typeof getRedis>): Promise<Order[]> {
  const data = await redis.get(ORDERS_KEY);
  return (data as Order[]) ?? [];
}

async function saveOrders(redis: ReturnType<typeof getRedis>, orders: Order[]): Promise<void> {
  await redis.set(ORDERS_KEY, orders);
}

// ── GET — Admin only ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const redis = getRedis();
    const orders = await loadOrders(redis);

    // Sort newest first
    orders.sort((a, b) => b.createdAt - a.createdAt);

    logger.info({ count: orders.length, user: auth.username }, "Orders retrieved");

    return successResponse(orders);
  } catch (error) {
    return handleApiError(error);
  }
}

// ── POST — Public (rate-limited) ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // Rate limiting: 3 order submissions per hour per IP
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "order-create", {
      requests: 3,
      window: "1h",
    });

    if (!rateLimit.success) {
      logger.warn({ ip }, "Order creation rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    // Parse and validate input
    const body = await parseJsonBody(req);
    const validated = createOrderSchema.parse(body);

    // Check for duplicate KPay reference
    const redis = getRedis();
    const orders = await loadOrders(redis);
    const duplicate = orders.find((o) => o.kpayRef === validated.kpayRef);

    if (duplicate) {
      throw new AppError(
        "This KPay reference has already been used",
        400,
        "DUPLICATE_KPAY_REF"
      );
    }

    // Create order
    const order: Order = {
      id: generateOrderId(),
      name: validated.name,
      kpayRef: validated.kpayRef,
      plan: validated.plan,
      customDataLimitGB: validated.customDataLimitGB ?? null,
      customMonths: validated.customMonths ?? null,
      customDevices: validated.customDevices ?? null,
      status: "pending",
      serverId: validated.serverId ?? null,
      keyId: null,
      accessUrl: null,
      createdAt: Date.now(),
      approvedAt: null,
    };

    // Mint the customer's claim credential. The raw token is returned exactly
    // once below and never stored; only its SHA-256 lives on the order, so the
    // order id by itself is not a credential.
    const claim = await issueClaimToken(order.id);
    order.claimHash = claim.claimHash;

    orders.push(order);
    await saveOrders(redis, orders);

    logger.info(
      { orderId: order.id, plan: order.plan },
      "Order created"
    );

    // Send Telegram notification to ALL admins if configured
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;

    if (botToken && chatIds) {
      const adminIds = chatIds.split(",").map((id) => id.trim());
      for (const chatId of adminIds) {
        try {
          const result = await sendOrderNotification(
            { botToken, chatId },
            {
              id: order.id,
              name: order.name,
              kpayRef: order.kpayRef,
              plan: order.plan,
              customDataLimitGB: order.customDataLimitGB ?? undefined,
              createdAt: order.createdAt,
            }
          );
          if (result.ok) {
            logger.info({ orderId: order.id, chatId }, "Telegram notification sent");
          } else {
            logger.warn({ orderId: order.id, chatId, error: result.error }, "Failed to send Telegram notification");
          }
        } catch (error) {
          logger.error({ orderId: order.id, chatId, error }, "Telegram notification error");
        }
      }
    }

    // claimToken is returned ONCE. The client must keep it to check status.
    return successResponse({ id: order.id, claimToken: claim.claimToken }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
