/**
 * Squad extraction cron (2026-05-20, cost-guard added 2026-05-23).
 *
 * For orgs running `featureSquadFromList`, this is the single LLM
 * call that derives the squad from the latest pasted numbered list —
 * see `src/lib/squad-from-list.ts` for the full pipeline.
 *
 * Cadence: every 30 min via vercel.json. **The Sonnet call only fires
 * on the tick(s) where it's actually useful.** Specifically:
 *
 *   1. There is a non-cancelled match within the next
 *      FINALISE_WINDOW_HOURS — otherwise no LLM call (just skip).
 *   2. AND that match does not yet have a full CONFIRMED squad
 *      (`attendance.count(status:CONFIRMED) < match.maxPlayers`) —
 *      once the squad is full the extraction has clearly happened
 *      and re-running would just upsert the same rows.
 *
 * That collapses what used to be 48 ticks/day × 7 days = ~336 Sonnet
 * calls per match week (every tick re-processing the same growing
 * message set) into 1-2 calls per match — exactly the design intent:
 * "one LLM call just before the match." Once finalised, every
 * subsequent tick is a cheap DB query and a `skipped` entry in the
 * response.
 *
 * On the rare extraction tick that fires, it does the full
 * `runSquadExtraction`: extract lists → diff-attribute → learn
 * aliases → finalise squad → write CONFIRMED + BENCH rows.
 *
 * Auth: CRON_SECRET (Bearer header), matching the existing crons.
 *
 * Falls open: any per-org failure is logged and the cron continues
 * with the next org.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runSquadExtraction } from "@/lib/squad-from-list";

const FINALISE_WINDOW_HOURS = 12;

type OrgResult = {
  orgId: string;
  name: string;
  lists: number;
  aliasesLearned: number;
  usersProvisioned: number;
  finalisedMatchId?: string;
  written?: number;
  unresolved?: string[];
  windowSince?: string;
  latestListNames?: string[];
  latestListReserves?: string[];
  /** Set when we deliberately skipped the Sonnet call. */
  skipped?: "no-imminent-match" | "squad-already-finalised";
  error?: string;
};

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

  const out: OrgResult[] = [];

  for (const org of orgs) {
    try {
      // ── Gate 1: is there an imminent match worth extracting for? ──
      const match = await db.match.findFirst({
        where: {
          activity: { orgId: org.id },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          date: { gte: new Date(now.getTime() - 60 * 60 * 1000), lte: finaliseCutoff },
        },
        orderBy: { date: "asc" },
        select: { id: true, date: true, maxPlayers: true },
      });
      if (!match) {
        out.push({
          orgId: org.id, name: org.name,
          lists: 0, aliasesLearned: 0, usersProvisioned: 0,
          skipped: "no-imminent-match",
        });
        continue;
      }

      // ── Gate 2: is the squad already finalised for this match? ──
      // CONFIRMED rows only come from squad extraction for these orgs
      // (attendance feature is off, so no admin/IN-OUT writes). If we
      // already have a full squad, another extraction tick would just
      // upsert the same data — pure Sonnet spend with no new state.
      const confirmedCount = await db.attendance.count({
        where: { matchId: match.id, status: "CONFIRMED" },
      });
      if (confirmedCount >= match.maxPlayers) {
        out.push({
          orgId: org.id, name: org.name,
          lists: 0, aliasesLearned: 0, usersProvisioned: 0,
          finalisedMatchId: match.id,
          skipped: "squad-already-finalised",
        });
        continue;
      }

      // Both gates passed — do the one real extraction.
      const result = await runSquadExtraction({
        orgId: org.id,
        finaliseForMatchId: match.id,
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
        windowSince: result.windowSince,
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
