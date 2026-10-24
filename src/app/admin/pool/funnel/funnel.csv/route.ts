/**
 * GET /admin/pool/funnel/funnel.csv: the owner's pool funnel as CSV (growth
 * slice G2), the same filters and numbers as the page. OWNER ONLY: 404 to
 * anybody who is not `User.isSuperadmin`. Counts only.
 */
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { loadPoolFunnel } from "@/lib/pool/funnel-loader";
import { funnelCsv, parseFunnelQuery } from "@/lib/pool/funnel-rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const userId = (await auth())?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) return new Response("Not found", { status: 404 });

  const now = new Date();
  const q = parseFunnelQuery(Object.fromEntries(new URL(request.url).searchParams), now);
  const { report, health } = await loadPoolFunnel(q, now);
  return new Response(`﻿${funnelCsv(report, health, q)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pool-funnel-${q.from}-to-${q.to}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
