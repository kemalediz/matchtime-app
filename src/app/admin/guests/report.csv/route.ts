/**
 * The Guest players Report as CSV (pool slice L5b): the same rows, filters
 * and words as the Report tab. Owners and admins of the club only.
 */
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { normaliseLang } from "@/lib/i18n/lang";
import { loadGuestFacts } from "@/lib/pool/guest-report-loader";
import { buildGuestReport, guestReportCsv, parseGuestPageQuery } from "@/lib/pool/guest-report";
import { reportHeader, reportPeriodLabel } from "../report-labels";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) return new Response("Not signed in", { status: 401 });
  const membership = await getUserOrg(session.user.id);
  if (!membership || !(await isOrgAdmin(session.user.id, membership.orgId))) return new Response("Admin access required", { status: 403 });

  const query = parseGuestPageQuery(Object.fromEntries(new URL(request.url).searchParams));
  const orgId = membership.orgId;
  const lang = normaliseLang(membership.org.language);
  const facts = await loadGuestFacts(orgId, { report: true });
  const report = buildGuestReport({ orgId, now: new Date(), games: facts.games, asks: facts.asks, matches: facts.matches, members: facts.members }, query);
  const csv = guestReportCsv(report, {
    header: reportHeader(lang),
    periodLabel: (key) => reportPeriodLabel(lang, query.period, key),
    totalLabel: t(lang).gst_total,
  });
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="guest-players-${query.period}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
