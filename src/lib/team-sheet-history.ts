/**
 * EVERY TEAM SHEET MATCHTIME POSTS IN A CLUB'S ADMIN GROUP, KEPT
 * (2026-10-30, FNF HQ).
 *
 * Why: on Thursday Hamzah replied "These are the final teams" to Tuesday's
 * proposed sheet, meaning those teams, and MatchTime asked for a YES on the
 * newer ones. The HQ log keeps a day, so Tuesday's post was long gone. Each
 * sheet is now kept here, 14 days, with the players on each side, so a
 * reply to it brings exactly those teams back (`team-proposal.ts`, the
 * "restore" command). The words of the reply are read by the teams
 * extractor; which teams it means is decided by the quoted post, never by
 * the words.
 *
 *   recordTeamSheet    a sheet MatchTime is about to post (the proposal, the
 *                      final teams shown)
 *   stampTeamSheets    the Pi acked a post in HQ: the sheet in it gets the
 *                      post's WhatsApp id (`hq-log-stanza.ts`)
 *   quotedTeamSheet    the sheet a reply quotes: by the quoted id, else by
 *                      MatchTime's own words in the Pi's copy of its post
 *   earlierSheetLike   a pasted sheet that is one MatchTime posted before
 *
 * MatchTime's own two copies of one string are compared, never a person's
 * words. Nothing here throws: before the migration HQ carries on without it.
 * Logs carry ids and counts only.
 */
import { db } from "./db";
import { sameWhatsAppMessage } from "./quoted-message";
import { sameSheet, type SheetSide } from "./team-proposal-rules";

export const SHEET_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** The post is claimed in the same request the sheet is recorded in. */
const STAMP_WINDOW_MS = 2 * 60 * 1000;
/** How much of a sheet's words identify it in a post (a lead line may
 *  come before it; a stored claim is cut at 1,000 characters). */
const KEY_CHARS = 400;

export interface StoredTeamSheet {
  id: string;
  matchId: string;
  slots: SheetSide[];
  createdAt: Date;
}

const key = (text: string) => text.slice(0, KEY_CHARS);

function asStored(r: { id: string; matchId: string; slots: unknown; createdAt: Date }): StoredTeamSheet {
  const slots = Array.isArray(r.slots)
    ? (r.slots as Array<Record<string, unknown>>)
        .filter((x) => typeof x?.userId === "string" && (x.team === "RED" || x.team === "YELLOW"))
        .map((x) => ({ userId: x.userId as string, team: x.team as SheetSide["team"] }))
    : [];
  return { id: r.id, matchId: r.matchId, slots, createdAt: r.createdAt };
}

/** A sheet MatchTime is posting in HQ. Never throws. */
export async function recordTeamSheet(args: { orgId: string; matchId: string; slots: SheetSide[]; text: string; now: Date }): Promise<void> {
  try {
    await db.adminTeamSheet.create({
      data: {
        orgId: args.orgId,
        matchId: args.matchId,
        slots: args.slots.map((x) => ({ userId: x.userId, team: x.team })),
        text: args.text,
        createdAt: args.now,
      },
    });
    await db.adminTeamSheet.deleteMany({ where: { orgId: args.orgId, createdAt: { lt: new Date(args.now.getTime() - SHEET_KEEP_MS) } } });
  } catch (err) {
    console.error(`[team-sheet] match ${args.matchId}: sheet not kept:`, err instanceof Error ? err.message : "failed");
  }
}

/**
 * The Pi acked one of MatchTime's posts in HQ (`sentText`, created at
 * `at`): each sheet recorded around then whose words are in it gets the
 * post's id. Returns how many. Never throws.
 */
export async function stampTeamSheets(args: { orgId: string; sentText: string; at: Date; waStanzaId: string }): Promise<number> {
  try {
    const near = await db.adminTeamSheet.findMany({
      where: {
        orgId: args.orgId,
        waStanzaId: null,
        createdAt: { gte: new Date(args.at.getTime() - STAMP_WINDOW_MS), lte: new Date(args.at.getTime() + STAMP_WINDOW_MS) },
      },
      select: { id: true, text: true },
    });
    const ids = near.filter((r) => args.sentText.includes(key(r.text))).map((r) => r.id);
    if (ids.length === 0) return 0;
    const { count } = await db.adminTeamSheet.updateMany({ where: { id: { in: ids } }, data: { waStanzaId: args.waStanzaId } });
    return count;
  } catch (err) {
    console.error(`[team-sheet] ${args.waStanzaId}: not stamped:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/**
 * The team sheet an HQ reply quotes, or null. By the quoted post's id; else,
 * when the Pi says the quoted post is MatchTime's, by MatchTime's own words
 * in its copy of the post. The newest wins. Never throws.
 */
export async function quotedTeamSheet(
  orgId: string,
  quoted: { messageId: string | null; text: string | null; fromMatchTime: boolean } | null,
): Promise<StoredTeamSheet | null> {
  if (!quoted) return null;
  try {
    const rows = await db.adminTeamSheet.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: { id: true, matchId: true, slots: true, text: true, waStanzaId: true, createdAt: true },
    });
    const byId = quoted.messageId ? rows.find((r) => !!r.waStanzaId && sameWhatsAppMessage(quoted.messageId, r.waStanzaId)) : undefined;
    if (byId) return asStored(byId);
    if (!quoted.fromMatchTime || !quoted.text) return null;
    const byWords = rows.find((r) => quoted.text!.includes(key(r.text)));
    return byWords ? asStored(byWords) : null;
  } catch (err) {
    console.error(`[team-sheet] quoted sheet not read:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}

/** The newest sheet of `matchId` MatchTime posted with exactly these sides. Never throws. */
export async function earlierSheetLike(matchId: string, sides: SheetSide[]): Promise<StoredTeamSheet | null> {
  try {
    const rows = await db.adminTeamSheet.findMany({
      where: { matchId },
      orderBy: { createdAt: "desc" },
      select: { id: true, matchId: true, slots: true, createdAt: true },
    });
    const hit = rows.map(asStored).find((r) => sameSheet(r.slots, sides));
    return hit ?? null;
  } catch {
    return null;
  }
}
