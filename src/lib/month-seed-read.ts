/**
 * A PASTED LIST, READ INTO A DRAFT FOR STARTING A MONTH (2026-10-29).
 *
 * The organiser's pasted list ("List for November", the group's own) is
 * read by the monthly reader, a model step (`monthly-reader.ts`, Kemal: no
 * code reads what people mean), and its lines matched to this club's
 * players: the member the model named, else the clean name or a known
 * alias. Three doors use it, and none of them parses text:
 *   - /admin/months, "Start <month> from your list" (`readListForSeed`);
 *   - the admin group (HQ), an organiser's paste, proposed for YES
 *     (`proposeMonthSeedPaste`), reached only through the admin group's
 *     shared model door (`admin-group-understand.ts`);
 *   - the players' group, an organiser's paste, proposed by DM
 *     (`month-seed-group.ts`), with the list the route already read.
 *
 * Moved out of `squad-month.ts` and `month-seed-hq.ts` (agent A's) so the
 * YES path, which the admin group reaches before its model door, imports
 * nothing that can call a model.
 */
import { db } from "./db";
import { appUrl } from "./app-url";
import { monthNameLabel } from "./i18n/dates";
import { monthSetupCopy } from "./i18n/month-setup";
import type { MonthlyList, MonthlyListEntry } from "./monthly-list";
import { comingMonth, SEED_PROPOSAL_TTL_MS, type MonthSeedProposalData, type MonthSeedReply } from "./month-seed-hq";
import { draftSeedFromList, londonMonthStart, normaliseSquadMode, type SeedDraftRow, type SeedDraftUnmatched, type SeedRowInput } from "./squad-month-rules";

/** Far longer than any group's list; a paste beyond it is not one. */
const MAX_LIST_CHARS = 8000;

export type ReadListError = "not-monthly" | "not-a-list";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Read a pasted list into a DRAFT: names matched to the club's current
 * players, PAYG, "says paid" and "4 only" as the reader read them. Writes
 * nothing: a month is only started by `startMonth`.
 */
export async function readListForSeed(
  orgId: string,
  text: string,
  now: Date = new Date(),
  /** The month being started, "2026-11-01". Omitted: this month. */
  forMonthStart?: string,
  opts: {
    /** The list as the monthly reader already read it. Omitted: read here. */
    list?: MonthlyList;
    /** Who pasted it (an organiser), for the reader's context. */
    senderUserId?: string | null;
  } = {},
): Promise<
  | { ok: true; rows: SeedDraftRow[]; unmatched: SeedDraftUnmatched[]; monthMismatch: boolean; headed: boolean }
  | { ok: false; error: ReadListError }
> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return { ok: false, error: "not-monthly" };
  let list = opts.list ?? null;
  if (!list) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_LIST_CHARS) return { ok: false, error: "not-a-list" };
    const { loadMonthlyReaderContext, readMonthlyMessage } = await import("./monthly-reader");
    const { withOrgAiBudget } = await import("./ai-budget");
    const reading = await withOrgAiBudget(orgId, async () => {
      const ctx = await loadMonthlyReaderContext({ orgId, matchId: null, now });
      const sender = opts.senderUserId ? ctx.members.find((m) => m.userId === opts.senderUserId) : undefined;
      return readMonthlyMessage(
        { body: text, sender: { userId: opts.senderUserId ?? null, name: sender?.name ?? null, organiser: sender?.organiser ?? true }, history: [], reply: null, now },
        ctx,
      );
    });
    if (reading.kind !== "list") return { ok: false, error: "not-a-list" };
    list = reading.list;
  }

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId, leftAt: null, user: { isActive: true } },
      select: { user: { select: { id: true, name: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const roster = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias),
  }));
  const month = Number((forMonthStart ?? londonMonthStart(now)).slice(5, 7));
  // The member the reader named is matched by that player's own name, so
  // a nickname the model resolved ("Bossman") drafts the right player.
  const nameOf = new Map(roster.map((m) => [m.userId, m.name ?? ""]));
  const byMember = (e: MonthlyListEntry): MonthlyListEntry =>
    e.facts?.memberId && nameOf.get(e.facts.memberId) ? { ...e, name: nameOf.get(e.facts.memberId) as string } : e;
  const matched: MonthlyList = {
    ...list,
    slots: list.slots.map(byMember),
    sections: { ...list.sections, cantPlay: list.sections.cantPlay.map(byMember) },
  };
  const draft = draftSeedFromList(matched, roster, { month });
  // The list's own wording stays what the organiser sees beside each name.
  const listNameOf = new Map([...list.slots, ...list.sections.cantPlay].filter((e) => e.facts?.memberId).map((e) => [e.facts!.memberId!, e.name]));
  const rows = draft.rows.map((r) => (listNameOf.has(r.userId) ? { ...r, listName: listNameOf.get(r.userId)! } : r));
  return { ok: true, rows, unmatched: draft.unmatched, monthMismatch: draft.monthMismatch, headed: list.month != null };
}

/**
 * A list pasted in the admin group by an organiser. Null when it is not a
 * list for a coming month this club has not started: the caller does what
 * it did before.
 */
export async function proposeMonthSeedPaste(args: {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  /** An OWNER or ADMIN. Nobody else starts a month. */
  organiserUserId: string;
  text: string;
  now: Date;
  /** The list as the monthly reader already read it (players' group).
   *  Omitted: the text is read here. */
  list?: MonthlyList;
}): Promise<MonthSeedReply | null> {
  const { orgId, now } = args;
  const target = await comingMonth(orgId, now);
  if (!target) return null;
  const read = await readListForSeed(orgId, args.text, now, target.monthStart, { list: args.list, senderUserId: args.organiserUserId });
  if (!read.ok || !read.headed || read.monthMismatch || read.rows.length === 0) return null;

  const rows: SeedRowInput[] = read.rows.map((r) => ({
    userId: r.userId,
    kind: r.kind,
    tier: r.tier,
    slot: r.slot,
    paid: r.paid,
    paidAmountPence: r.paidAmountPence,
    gamesCommitted: r.gamesCommitted,
    listName: r.listName,
  }));
  const data: MonthSeedProposalData = { activityId: target.activity.id, games: target.games, rows };
  try {
    await db.adminSquadProposal.updateMany({ where: { orgId, resolvedAt: null }, data: { resolvedAt: now, outcome: "superseded" } });
    await db.adminSquadProposal.create({
      data: {
        orgId,
        // A month's list is about no one match.
        matchId: "",
        waMessageId: args.messageId,
        proposedByUserId: args.organiserUserId,
        playingUserIds: rows.map((r) => r.userId),
        monthStart: target.monthStart,
        monthSeed: data as unknown as object,
        expiresAt: new Date(now.getTime() + SEED_PROPOSAL_TTL_MS),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  const c = monthSetupCopy(args.lang);
  const month = monthNameLabel(args.lang, target.first);
  console.log(`[month-seed-hq] ${args.messageId}: ${target.monthStart} proposed for ${orgId}: ${rows.length} matched, ${read.unmatched.length} not known`);
  const proposal = {
    month,
    count: rows.length,
    names: read.rows.map((r) => r.listName || r.name).join(", "),
    unknown: read.unmatched.length > 0 ? read.unmatched.map((u) => u.name).join(", ") : null,
    link: appUrl("/admin/months"),
  };
  return { outcome: "month-seed-proposed", replyText: c.hq_seed_proposal(proposal), proposal };
}

