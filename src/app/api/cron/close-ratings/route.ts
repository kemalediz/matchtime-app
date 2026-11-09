import { poolHousekeeping } from "@/lib/pool/housekeeping";
import { purgeOldMentions } from "@/lib/group-mentions";
import { NextResponse } from "next/server";

/**
 * The daily 06:00 cron (vercel.json). Rating windows are checked at request
 * time, so the ratings part does nothing. It also runs the player pool's
 * daily housekeeping (slice L2): unconfirmed sign-ups and old rate-limit
 * records are deleted (src/lib/pool/housekeeping.ts). And (2026-11-09) who
 * a group message tagged is deleted after 7 days (`purgeOldMentions`,
 * src/lib/group-mentions.ts), the retention of "@Match Time DM these people".
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = await poolHousekeeping();
  const mentionsDeleted = await purgeOldMentions();
  return NextResponse.json({ ok: true, pool, mentionsDeleted });
}
