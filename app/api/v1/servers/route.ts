/**
 * GET /api/v1/servers — Public endpoint returning server names for order form
 * Only returns id and name — no sensitive API URLs or certs
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis, handleApiError } from "@/lib/api-utils";
import type { OutlineServer } from "@/lib/types";

export const runtime = "nodejs";

interface AdminData {
  servers: OutlineServer[];
}

export async function GET(_req: NextRequest) {
  try {
    const redis = getRedis();
    const raw = await redis.get<AdminData | string>("outline_admin_data");

    let adminData: AdminData | null = null;
    if (typeof raw === "string") {
      try { adminData = JSON.parse(raw); } catch { adminData = null; }
    } else {
      adminData = raw;
    }

    const servers = (adminData?.servers ?? []).map((s) => ({
      id: s.id,
      name: s.name,
    }));

    return NextResponse.json(servers);
  } catch (error) {
    return handleApiError(error);
  }
}
