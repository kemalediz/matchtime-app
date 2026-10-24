import { poolHousekeeping } from "@/lib/pool/housekeeping";
import { NextResponse } from "next/server";

/**
 * The daily 06:00 cron (vercel.json). Rating windows are checked at request
 * time, so the ratings part does nothing. It also runs the player pool's
 * daily housekeeping (slice L2): unconfirmed sign-ups and old rate-limit
 * records are deleted (src/lib/pool/housekeeping.ts).
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = await poolHousekeeping();
  return NextResponse.json({ ok: true, pool });
}
