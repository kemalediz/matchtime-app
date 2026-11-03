/**
 * WHO IS WHO ON THE ORGANISER'S LIST (2026-11-03, Vets MNF).
 *
 * A club that joins has most of its members imported from the WhatsApp
 * member list with no name (Vets: 20 of 27), so the month's list ("Nabz
 * (paid 4 only)", "steff (paid full)") matched 4 of 13 names. The draft
 * now keeps every name it could not match (`month-seed-match-rules.ts`),
 * and the organiser, and only he, sees the club's nameless members by
 * phone and says who is who:
 *   - on /admin/months, a picker beside each unknown name (`matchSeedName`);
 *   - in WhatsApp, replying to the DM in his own words ("Craig is 3"),
 *     read by the model (`month-seed-reply.ts`), never by phrases.
 * His choice puts the member on the draft with that line's facts, saves
 * the list's name as the member's alias, and as his name while he has
 * none, so next month's list, the rate page and the team sheet know him.
 *
 * A phone number is shown only in the organiser's own DM and on the
 * organisers' page, never in any group.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { monthNameLabel } from "./i18n/dates";
import { appUrl } from "./app-url";
import { formatPhoneForDisplay } from "./phone";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { usableName } from "./player-display-name";
import { applyListMatch, numberNameless, type ListMatchError, type NamelessRef } from "./month-seed-match-rules";
import type { MonthSeedProposalData } from "./month-seed-hq";

export interface NamelessMember {
  userId: string;
  phone: string;
}

/**
 * The club's current members MatchTime has no name for: no usable
 * `User.name` and no alias here. Only those with a phone (the organiser
 * cannot tell who anybody else is). Oldest member first, so the numbering
 * is stable while nobody is named.
 */
export async function loadNamelessMembers(orgId: string, exclude: readonly string[] = []): Promise<NamelessMember[]> {
  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId, leftAt: null, ...ORDINARY_MEMBER_WHERE, user: { isActive: true } },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true } }),
  ]);
  const aliased = new Set(aliases.map((a) => a.userId));
  const skip = new Set(exclude);
  return memberships
    .map((m) => m.user)
    .filter((u) => !usableName(u.name) && !aliased.has(u.id) && !skip.has(u.id) && !!u.phoneNumber)
    .map((u) => ({ userId: u.id, phone: u.phoneNumber as string }));
}

/**
 * The organiser said this member is `listName` on his list: the name is
 * saved as the member's alias here (as starting a month does for every
 * matched line), and as his name while he has none. Best effort: a
 * failure leaves the draft matched and the member nameless.
 */
export async function nameMemberFromList(orgId: string, userId: string, listName: string): Promise<void> {
  const name = usableName(listName);
  if (!name) return;
  try {
    const { saveListAliases } = await import("./squad-month");
    // The alias first: it is skipped when it is the member's own name.
    await saveListAliases(orgId, [{ userId, alias: name }]);
    const { count } = await db.user.updateMany({ where: { id: userId, name: null }, data: { name } });
    if (count === 1) console.log(`[month-seed-match] named ${userId} "${name}" from the organiser's list`);
  } catch (err) {
    console.error(`[month-seed-match] naming ${userId} from the list failed:`, err instanceof Error ? err.message : "failed");
  }
}

/**
 * The DM that offers the draft, and the nameless members as it numbers
 * them (stored with the draft, so his "Craig is 3" means the member he saw
 * as 3). With unknown names and nameless members it asks who is who; with
 * unknown names and nobody nameless it says they are not known.
 */
export async function seedDmText(args: {
  orgId: string;
  lang: string | null | undefined;
  monthStart: string;
  data: MonthSeedProposalData;
  hq: boolean;
}): Promise<{ text: string; nameless: NamelessRef[] }> {
  const { data } = args;
  const s = t(args.lang);
  const ids = data.rows.map((r) => r.userId);
  const users = ids.length > 0 ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? ""]));
  const names = data.rows
    .map((r) => `${r.listName || nameOf.get(r.userId) || ""}${r.kind === "payg" ? " (PAYG)" : r.gamesCommitted ? ` (${r.gamesCommitted})` : ""}`)
    .join(", ");
  const unmatched = data.unmatched ?? [];
  const nameless = unmatched.length > 0 ? await loadNamelessMembers(args.orgId, ids) : [];
  const numbered = numberNameless(nameless.map((m) => m.userId));
  const phoneOf = new Map(nameless.map((m) => [m.userId, m.phone]));
  const unknownNames = unmatched.map((u) => u.name).join(", ");
  const text = s.mwk_dm_seed_from_group({
    month: monthNameLabel(args.lang, new Date(`${args.monthStart}T12:00:00.000Z`)),
    count: data.rows.length,
    names,
    unknown: unmatched.length > 0 && numbered.length === 0 ? unknownNames : null,
    match:
      unmatched.length > 0 && numbered.length > 0
        ? {
            names: unknownNames,
            members: numbered.map((m) => `${m.n}. ${formatPhoneForDisplay(phoneOf.get(m.userId) ?? "")}`),
            example: s.mwk_dm_seed_match_example({ name: unmatched[0].name, n: 1 }),
          }
        : null,
    link: appUrl("/admin/months"),
    hq: args.hq,
  });
  return { text, nameless: numbered };
}

export type MatchSeedError = ListMatchError | "not-found" | "not-allowed" | "not-a-member";

/** The open month draft of this club that is waiting for its YES, if any. */
async function openSeedProposal(orgId: string, now: Date, proposalId?: string) {
  return db.adminSquadProposal.findFirst({
    where: { orgId, ...(proposalId ? { id: proposalId } : {}), resolvedAt: null, expiresAt: { gt: now }, monthStart: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, monthStart: true, monthSeed: true },
  });
}

/**
 * The months page's picker: an organiser says the list's `ref` name is
 * this member. Checked again here: an organiser of this club, a current
 * member of it, a name still unknown on an open draft.
 */
export async function matchSeedName(args: {
  orgId: string;
  actorUserId: string;
  proposalId: string;
  ref: string;
  userId: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: MatchSeedError }> {
  const now = args.now ?? new Date();
  const [actor, member, proposal] = await Promise.all([
    db.membership.findFirst({
      where: { orgId: args.orgId, userId: args.actorUserId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
      select: { id: true },
    }),
    db.membership.findFirst({
      where: { orgId: args.orgId, userId: args.userId, leftAt: null, ...ORDINARY_MEMBER_WHERE, user: { isActive: true } },
      select: { id: true },
    }),
    openSeedProposal(args.orgId, now, args.proposalId),
  ]);
  if (!actor) return { ok: false, error: "not-allowed" };
  if (!proposal?.monthSeed) return { ok: false, error: "not-found" };
  if (!member) return { ok: false, error: "not-a-member" };
  const applied = applyListMatch(proposal.monthSeed as unknown as MonthSeedProposalData, args.ref, args.userId);
  if (!applied.ok) return applied;
  const res = await db.adminSquadProposal.updateMany({
    where: { id: proposal.id, resolvedAt: null },
    data: { monthSeed: applied.data as unknown as object, playingUserIds: applied.data.rows.map((r) => r.userId) },
  });
  if (res.count === 0) return { ok: false, error: "not-found" };
  await nameMemberFromList(args.orgId, args.userId, applied.entry.name);
  console.log(`[month-seed-match] proposal=${proposal.id} ${args.ref} matched to ${args.userId} on the page by ${args.actorUserId}`);
  return { ok: true };
}

export interface SeedMatchView {
  proposalId: string;
  monthStart: string;
  /** The names still unknown, each with who it could be. */
  names: Array<{ ref: string; name: string; options: Array<{ userId: string; label: string }> }>;
}

/**
 * For /admin/months: the open draft's unknown names, each with the
 * members it could be (an ambiguous name's namesakes by name, then every
 * nameless member by phone). Null when nothing is waiting to be matched.
 */
export async function loadSeedMatchView(orgId: string, now: Date = new Date()): Promise<SeedMatchView | null> {
  const proposal = await openSeedProposal(orgId, now);
  const data = proposal?.monthSeed as unknown as MonthSeedProposalData | null | undefined;
  const unmatched = data?.unmatched ?? [];
  if (!proposal?.monthStart || !data || unmatched.length === 0) return null;
  const onDraft = data.rows.map((r) => r.userId);
  const nameless = await loadNamelessMembers(orgId, onDraft);
  const candidateIds = [...new Set(unmatched.flatMap((u) => u.candidates))].filter((id) => !onDraft.includes(id));
  const named = candidateIds.length > 0 ? await db.user.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(named.map((u) => [u.id, usableName(u.name)]));
  const byPhone = nameless.map((m) => ({ userId: m.userId, label: formatPhoneForDisplay(m.phone) }));
  return {
    proposalId: proposal.id,
    monthStart: proposal.monthStart,
    names: unmatched.map((u) => ({
      ref: u.ref,
      name: u.name,
      options: [
        ...u.candidates.filter((id) => nameOf.get(id)).map((id) => ({ userId: id, label: nameOf.get(id) as string })),
        ...byPhone,
      ],
    })),
  };
}
