/**
 * Squad extraction cron (2026-05-20). For orgs running
 * `featureSquadFromList`, this is the single LLM call that derives the
 * squad from the latest pasted numbered list — see
 * `src/lib/squad-from-list.ts` for the full pipeline and design notes.
 *
 * Cadence: every 30 min via vercel.json. Each run, for each
 * featureSquadFromList org, we:
 *   1. Always run the diff + alias-learning pass over the last 3 days
 *      of stored GroupMessage rows. Cheap (~one Sonnet call per org per
 *      tick that has new messages). Alias warming is the main reason
 *      to run continuously rather than only at kickoff — by the time
 *      we finalise we want as many ground-truth aliases as possible.
 *   2. If there's a non-cancelled match within the next 12h, ALSO
 *      finalise the squad: take the latest list, resolve each name
 *      via the chain (alias → exact → fuzzy → provision-with-no-phone),
 *      write CONFIRMED Attendance rows + BENCH rows for reserves.
 *      Idempotent — re-running over an already-filled match upserts
 *      the same data and skips userIds already CONFIRMED.
 *
 * Auth: CRON_SECRET (Bearer header), matching the existing crons.
 *
 * Falls open: any per-org failure is logged and the cron continues
 * with the next org. Aliases learned in one tick persist even if the
 * finalise step later errors.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runSquadExtraction } from "@/lib/squad-from-list";

const FINALISE_WINDOW_HOURS = 12;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const finaliseCutoff = new Date(now.getTime() + FINALISE_WINDOW_HOURS * 60 * 60 * 1000);

  const orgs = await db.organisation.findMany({
    where: { featureSquadFromList: true, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });

  const out: Array<{
    orgId: string;
    name: string;
    lists: number;
    aliasesLearned: number;
    usersProvisioned: number;
    finalisedMatchId?: string;
    written?: number;
    unresolved?: string[];
    latestListNames?: string[];
    latestListReserves?: string[];
    error?: string;
  }> = [];

  for (const org of orgs) {
    try {
      // Match within the next FINALISE_WINDOW_HOURS that doesn't yet
      // have any CONFIRMED attendance. We don't refuse to finalise an
      // already-filled match (the helper is idempotent) — we skip the
      // finalise step to save one extraction pass when there's nothing
      // to do.
      const match = await db.match.findFirst({
        where: {
          activity: { orgId: org.id },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          date: { gte: new Date(now.getTime() - 60 * 60 * 1000), lte: finaliseCutoff },
        },
        orderBy: { date: "asc" },
        select: { id: true, date: true },
      });

      const result = await runSquadExtraction({
        orgId: org.id,
        finaliseForMatchId: match?.id,
      });
      out.push({
        orgId: org.id,
        name: org.name,
        lists: result.lists,
        aliasesLearned: result.aliasesLearned,
        usersProvisioned: result.usersProvisioned,
        finalisedMatchId: result.finalisedMatchId,
        written: result.written,
        unresolved: result.unresolved,
        latestListNames: result.latestListNames,
        latestListReserves: result.latestListReserves,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[extract-squads] org ${org.id} failed:`, err);
      out.push({
        orgId: org.id,
        name: org.name,
        lists: 0,
        aliasesLearned: 0,
        usersProvisioned: 0,
        error: msg,
      });
    }
  }

  return NextResponse.json({ ok: true, processed: out.length, results: out });
}
