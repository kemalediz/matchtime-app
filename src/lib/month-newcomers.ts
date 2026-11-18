/**
 * AN ORGANISER PUTS SOMEBODY ON A MONTH, the writes (Kemal, 2026-11-03).
 *
 * Two doors reach it, and both act on facts the model read, never on
 * phrases (the rules are `month-newcomer-rules.ts`):
 *   - his RE-POSTED list in a running month with a new line ("14. Tom
 *     (paid)"), reconciled by `monthly-paste.ts`;
 *   - a TAGGED REQUEST ("@Match Time add Tom to the November list, he's
 *     paid", "Tom'u Kasım listesine ekle, ödedi") in the players' group,
 *     the organisers' group or a DM, read by the monthly reader as an
 *     "add" (`applyMonthAdd`).
 *
 * The person joins the month as "Add a player, Regular" on /admin/months
 * makes him one (`applySignup`, source "admin", by the organiser): a
 * regular for the games left (PAYG when his words say), "says paid" when
 * they say he paid, "4 only" when they say so, and on the next game's
 * squad (`placeOnWeek`).
 *
 * A NAME MATCHTIME DOES NOT KNOW. Vets MNF has 20 members with no name. A
 * name that is nobody becomes a new player with no phone, on the month at
 * once; a name the reader tied to a member with no name (his WhatsApp
 * name) could be him, so nobody is added. Either way the organiser gets
 * ONE DM numbering the club's members with no name, by phone (to him
 * only), and says who is who in his own words ("Zak is 3"), read by the
 * month-seed reply reader (`readSeedReply`'s "match", #507). His answer:
 *   - a new player made for the name is FOLDED INTO that member with the
 *     user-merge tool (`applyUserMerge`): the member keeps his phone and
 *     id, and takes the month's row, the squad place and the name;
 *   - a name nobody was added for LINKS that member: he joins the month
 *     with the line's facts.
 * The question is stored with its DM (a `SentNotification` row of kind
 * `NEWCOMER_ASK_KIND`, the state as JSON), and answered only while it is
 * the message he is replying to.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { monthSetupCopy } from "./i18n/month-setup";
import { normaliseAdminChannelMode } from "./admin-channel-rules";
import { monthNameLabel } from "./i18n/dates";
import { appUrl } from "./app-url";
import { formatPhoneForDisplay } from "./phone";
import { formatLondon } from "./london-time";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import { loadClubQuietHours } from "./club-quiet-hours";
import { nameKey } from "./squad-month-rules";
import { coverageForAdded, shownCoverage, type CoverageRead } from "./month-coverage-rules";
import { numberNameless } from "./month-seed-match-rules";
import type { MonthlyReading } from "./monthly-reader-prompt";
import type { PipelineModel } from "./pipeline/llm";
import { refKey } from "./person-ref-key";
import {
  classifyNewcomer,
  NEWCOMER_ASK_KIND,
  NEWCOMER_ASK_TTL_MS,
  parseNewcomerQuestion,
  resolveNewcomerMatches,
  type NewcomerLine,
  type NewcomerName,
  type NewcomerQuestion,
} from "./month-newcomer-rules";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** The organiser's DM, never in the club's quiet hours. */
async function dm(orgId: string, phone: string, text: string, now: Date): Promise<void> {
  const sendAfter = adminNoticeSendAfter(now, await loadClubQuietHours(orgId));
  await db.botJob.create({ data: { orgId, kind: "dm", phone: phone.replace(/^\+/, ""), text, ...(sendAfter ? { sendAfter } : {}) } });
}

export interface JoinResult {
  ok: boolean;
  /** Something about the month changed. */
  changed: boolean;
  outcome: "regular" | "waiting" | "payg" | "out" | null;
  gamesLeft: number;
  /**
   * A regular, as his row is STORED after the join (review of #611, item 4:
   * a reply never says what was asked for, only what was written): the
   * games he covers, whether that is the whole month, the month's playable
   * games, and `leftOnly`: a month under way, he covers fewer than the
   * whole month, and nobody said which (the reply says how to change it).
   */
  covered?: { games: number; whole: boolean; playable: number; leftOnly: boolean };
  /** What he covers was asked for and refused (round 4, item 5): the reply
   *  says so. Nothing of it, nor his says-paid claim, was written. */
  coverageRefused?: import("./month-member-coverage").SetCoverageError;
}

/**
 * The person joins the month as the organiser put him on it, exactly as
 * /admin/months "Add a player, Regular" does (or PAYG when the line says),
 * then what he covers (the line's `coverage`, through the coverage
 * editor's own write and bounds, for a new row and a returning one alike),
 * the line's "says paid" and "4 only". `weekDay`: the day of the game a
 * plain PAYG line is for.
 */
export async function joinMonthAsOrganiser(p: {
  orgId: string;
  monthId: string;
  userId: string;
  line: NewcomerLine;
  organiserUserId: string;
  weekDay?: number | null;
  /** The organiser's words for him (his line, or his message): what the
   *  organisers' line quotes when the one fit rule changed the count. */
  words?: string | null;
  now: Date;
}): Promise<JoinResult> {
  const { applySignup, loadSignupMonth } = await import("./month-signup");
  const month = await loadSignupMonth(p.monthId);
  const gamesLeft = month ? month.kickoffs.filter((k) => k.getTime() > p.now.getTime()).length : 0;
  const days = p.line.payg ? (p.line.paygDays.length > 0 ? p.line.paygDays : p.weekDay ? [p.weekDay] : []) : [];
  const res = await applySignup({
    monthId: p.monthId,
    userId: p.userId,
    choice: p.line.payg ? "payg" : "in",
    days,
    source: "admin",
    actorUserId: p.organiserUserId,
    byOrganiser: true,
    // His games go with the join (2026-11-16): through the one fit rule,
    // recorded before anybody is told what he owes, and counted from now
    // for a leaver who paid and keeps his row (`applySignup`).
    games: p.line.payg ? null : p.line.games,
    words: p.words ?? null,
    now: p.now,
  });
  if (!res.ok) return { ok: false, changed: false, outcome: null, gamesLeft };
  let changed = res.changed || !!res.gamesStored;
  let covered: JoinResult["covered"];
  let refused: JoinResult["coverageRefused"];
  if (res.outcome === "regular") {
    // What he covers, when the organiser said, CHECKED first (round 4, item
    // 2): a refused coverage records neither it nor the claim, and the
    // reply says so (item 5).
    const wantCover = !!p.line.coverage && !p.line.payg;
    const mc = wantCover ? await import("./month-member-coverage") : null;
    const check = mc && p.line.coverage ? await mc.checkMonthMemberCoverage({ squadMonthId: p.monthId, userId: p.userId, coverage: p.line.coverage, now: p.now }) : null;
    if (check && !check.ok) refused = check.error;
    // Then the claim, then the coverage (review round 2, item 2): priced as
    // one who says he paid, as a seeded says-paid regular is, a called-off
    // week's credit kept for later, by every door; and his words say the
    // claim is for that coverage (`claimCovers`), so it is not written down
    // at the old amount first.
    if (p.line.paid && !refused) {
      // D3: a claim, never a confirmation; the organiser said it.
      const { claimMonthPaid } = await import("./month-payment");
      if (await claimMonthPaid({ monthId: p.monthId, userId: p.userId, source: "organiser", amountPence: p.line.paidPence, now: p.now })) changed = true;
    }
    if (mc && p.line.coverage && !refused) {
      const r = await mc.setMonthMemberCoverage({ squadMonthId: p.monthId, userId: p.userId, coverage: p.line.coverage, claimCovers: p.line.paid, now: p.now });
      if (r.ok && r.changed) changed = true;
      if (!r.ok) refused = r.error;
    }
    // His "4 only" went with the join (`applySignup`, PR #610), before the claim.
    // The row as stored, for the reply.
    const { loadCoverageView } = await import("./month-member-coverage");
    const view = await loadCoverageView(p.monthId, p.now).catch(() => null);
    const mine = view?.members.get(p.userId);
    if (view && mine) {
      // As the organiser reads it: in playable games (round 3, item 5).
      const shown = shownCoverage(mine, view.month);
      covered = { games: shown.games, whole: shown.wholeMonth, playable: view.month.playable, leftOnly: view.started && !shown.wholeMonth && !p.line.coverage };
    }
  }
  // As the months page does after an organiser's change: what a returning
  // regular is owed is worked out at once (the hourly sweep retries).
  if (res.changed) {
    try {
      const { reconcileLeavers } = await import("./month-close");
      await reconcileLeavers(p.orgId, p.now, undefined, { notify: false });
    } catch (err) {
      console.error(`[month-newcomers] working out what a leaver of ${p.monthId} is owed failed (the hourly sweep retries):`, err);
    }
  }
  return { ok: true, changed, outcome: res.outcome, gamesLeft, ...(covered ? { covered } : {}), ...(refused ? { coverageRefused: refused } : {}) };
}

/**
 * The one line every door with no coverage question says (review of #611,
 * item 9: a re-posted list, the players' group's tagged add, a DM add, the
 * "who is this?" answer): these regulars were added for the games left,
 * and how to change it.
 */
export function gamesLeftNote(lang: string | null, names: string[], month: string, hasOrganisersGroup: boolean): string {
  return monthSetupCopy(lang).added_left_note({
    names: names.join(", "),
    count: names.length,
    first: names[0] ?? "",
    month,
    link: appUrl("/admin/months"),
    // Round 2, item 5: the group is named only for a club that has one.
    group: hasOrganisersGroup,
  });
}

/** The club talks to its organisers in an organisers' group (HQ). */
export function hasOrganisersGroup(org: { adminGroupId?: string | null; adminChannelMode?: string | null } | null | undefined): boolean {
  return !!org?.adminGroupId && normaliseAdminChannelMode(org.adminChannelMode) === "admin-group";
}

/**
 * ONE DM to the organiser (review round 2, items 3 and 4): when he is also
 * asked "who is this?", the games-left note rides at the top of that
 * question; otherwise the note goes on its own. `ask` sends the question
 * with the prefix given and says whether it went.
 */
export async function tellOrganiserOnce(p: {
  note: string | null;
  ask: ((prefix: string | null) => Promise<boolean>) | null;
  send: (text: string) => Promise<void>;
}): Promise<"asked" | "note" | "none"> {
  if (p.ask && (await p.ask(p.note))) return "asked";
  if (p.note) {
    await p.send(p.note);
    return "note";
  }
  return "none";
}

/** A new player with no phone, named as the organiser wrote him. */
export async function createNewcomer(orgId: string, name: string): Promise<string | null> {
  const { createProvisionalByName } = await import("./resolve-sender");
  // `deliberate`: an organiser wrote the name on purpose ("Mo" is a name).
  const created = await createProvisionalByName(orgId, name, null, { deliberate: true });
  return created?.userId ?? null;
}

const monthLabelOf = async (monthId: string, lang: string | null) => {
  const { loadSignupMonth } = await import("./month-signup");
  const m = await loadSignupMonth(monthId);
  return m ? monthNameLabel(lang, m.firstKickoff) : "";
};

/** The DM's text and its numbering, for these names. Null when there is
 *  nobody with no name to choose from. */
async function questionText(orgId: string, lang: string | null, monthId: string, names: NewcomerName[]): Promise<{ text: string; nameless: NewcomerQuestion["nameless"] } | null> {
  const { loadNamelessMembers } = await import("./month-seed-match");
  const nameless = await loadNamelessMembers(orgId, names.map((n) => n.userId).filter((u): u is string => !!u));
  if (nameless.length === 0 || names.length === 0) return null;
  const { loadSeenAs } = await import("./player-display-name");
  const seen = await loadSeenAs(orgId, nameless.map((m) => m.userId)).catch(() => new Map<string, string>());
  const numbered = numberNameless(nameless.map((m) => m.userId));
  const phoneOf = new Map(nameless.map((m) => [m.userId, m.phone]));
  const s = t(lang);
  const text = s.mwk_dm_newcomers_ask({
    month: await monthLabelOf(monthId, lang),
    added: names.filter((n) => n.userId).map((n) => n.name),
    waiting: names.filter((n) => !n.userId).map((n) => n.name),
    members: numbered.map((m) => `${m.n}. ${formatPhoneForDisplay(phoneOf.get(m.userId) ?? "")}${seen.get(m.userId) ? ` (WhatsApp: ${seen.get(m.userId)})` : ""}`),
    example: s.mwk_dm_seed_match_example({ name: names[0].name, n: 1 }),
  });
  return { text, nameless: numbered };
}

/**
 * Ask the organiser, in ONE DM, who the names are: the new players made
 * for names that are nobody (`userId` set) and the names that could be a
 * member with no name yet (`userId` null, nobody added). A name of the
 * second kind is asked about once a month; the first kind is new each
 * time. Nothing is sent when the club has nobody with no name. True when
 * the DM was queued.
 */
export async function askWhoTheyAre(p: {
  orgId: string;
  monthId: string;
  organiserUserId: string;
  /** Once per paste or request: its WhatsApp id. */
  sourceRef: string;
  names: Array<{ name: string; userId: string | null; line: NewcomerLine }>;
  /** Said first, in the same DM (his own DM's answer, `handleMonthAddDm`). */
  prefix?: string | null;
  now: Date;
}): Promise<boolean> {
  try {
    const [org, organiser] = await Promise.all([
      db.organisation.findUnique({ where: { id: p.orgId }, select: { language: true } }),
      db.user.findUnique({ where: { id: p.organiserUserId }, select: { phoneNumber: true } }),
    ]);
    if (!organiser?.phoneNumber) return false;
    const fresh: typeof p.names = [];
    const claimed: string[] = [];
    for (const n of p.names) {
      if (n.userId) {
        fresh.push(n);
        continue;
      }
      const key = `org-${p.orgId}:month-newcomers-asked:${p.monthId}:${nameKey(n.name)}`;
      try {
        await db.sentNotification.create({ data: { key, kind: "month-newcomers-asked" } });
        claimed.push(key);
        fresh.push(n);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    // Nothing sent after all: the names are not "asked", so the next time asks.
    const release = () => (claimed.length > 0 ? db.sentNotification.deleteMany({ where: { key: { in: claimed } } }).catch(() => undefined) : undefined);
    const names: NewcomerName[] = fresh.map((n, i) => ({ ref: `u${i + 1}`, name: n.name, userId: n.userId, line: n.line }));
    const lang = org?.language ?? null;
    const asked = await questionText(p.orgId, lang, p.monthId, names);
    if (!asked) {
      await release();
      return false;
    }
    const q = { ...asked, text: p.prefix ? `${p.prefix}\n\n${asked.text}` : asked.text };
    const state: NewcomerQuestion = { v: 1, orgId: p.orgId, monthId: p.monthId, dm: q.text, names, nameless: q.nameless };
    try {
      await db.sentNotification.create({
        data: { key: `org-${p.orgId}:${NEWCOMER_ASK_KIND}:${p.monthId}:${p.sourceRef}`, kind: NEWCOMER_ASK_KIND, targetUser: p.organiserUserId, text: JSON.stringify(state) },
      });
    } catch (err) {
      await release();
      if (isUniqueViolation(err)) return false; // asked for this paste already
      throw err;
    }
    await dm(p.orgId, organiser.phoneNumber, q.text, p.now);
    console.log(`[month-newcomers] asked ${p.organiserUserId} who ${names.length} name(s) on ${p.monthId} are (${q.nameless.length} members with no name)`);
    return true;
  } catch (err) {
    console.error("[month-newcomers] the who-is-this DM failed:", err instanceof Error ? err.message : "failed");
    return false;
  }
}

// ── His answer ("Zak is 3") ────────────────────────────────────────────

export interface NewcomerDmHandled {
  handled: "month-newcomers-matched";
  matched: number;
  failed: number;
}

/**
 * The organiser's DM reply to the "who is this?" DM, while it is open and
 * it is the message he answers. Read by the month-seed reply reader (the
 * model), with the names as "not matched" and the members with no name by
 * number. Only "match" changes act; anything else goes on to the other DM
 * handlers. Never throws.
 */
export async function handleNewcomerDmReply(input: {
  userId: string;
  text: string;
  replyPhone: string | null;
  waMessageId: string;
  answering: () => Promise<string | null>;
  now: Date;
  deps?: { model?: PipelineModel | null };
}): Promise<NewcomerDmHandled | null> {
  try {
    return await reply(input);
  } catch (err) {
    console.error("[month-newcomers] reply failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}

async function reply(input: Parameters<typeof handleNewcomerDmReply>[0]): Promise<NewcomerDmHandled | null> {
  const { userId, now } = input;
  const row = await db.sentNotification.findFirst({
    where: { kind: NEWCOMER_ASK_KIND, targetUser: userId, createdAt: { gte: new Date(now.getTime() - NEWCOMER_ASK_TTL_MS) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, text: true },
  });
  const q = parseNewcomerQuestion(row?.text);
  if (!row || !q || q.names.length === 0) return null;
  if ((await input.answering())?.trim() !== q.dm.trim()) return null;
  const memberships = await db.membership.findMany({
    where: { orgId: q.orgId, leftAt: null, ...ORDINARY_MEMBER_WHERE, user: { isActive: true } },
    select: { role: true, user: { select: { id: true, name: true, phoneNumber: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!memberships.some((m) => m.user.id === userId && (m.role === "OWNER" || m.role === "ADMIN"))) return null;
  // One delivery is read and answered once, claimed before the model.
  try {
    await db.sentNotification.create({ data: { key: `org-${q.orgId}:month-newcomers-reply:${input.waMessageId}`, kind: "month-newcomers-reply" } });
  } catch {
    return null;
  }
  const aliases = await db.userAlias.findMany({ where: { orgId: q.orgId }, select: { userId: true, alias: true } });
  const members = memberships
    .filter((m) => m.user.name)
    .map((m, i) => ({ ref: `p${i + 1}`, userId: m.user.id, name: m.user.name as string, aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias) }));
  const current = new Set(memberships.map((m) => m.user.id));
  const nameless = q.nameless.filter((m) => current.has(m.userId)).map((m) => ({ ref: `n${m.n}`, n: m.n, userId: m.userId }));
  const { readSeedReply } = await import("./month-seed-reply");
  const { withOrgAiBudget } = await import("./ai-budget");
  const answer = await withOrgAiBudget(q.orgId, () =>
    readSeedReply(
      { draft: [], members, unmatched: q.names.map((n) => ({ ref: n.ref, name: n.name })), nameless, asked: q.dm, text: input.text },
      input.deps,
    ),
  );
  console.info(`[month-newcomers] user=${userId} answer=${answer.kind}${answer.kind === "other" ? ` why=${answer.why}` : ""}`);
  if (answer.kind !== "change") return null;
  const resolutions = resolveNewcomerMatches(
    q,
    answer.changes.flatMap((c) => (c.action === "match" ? [{ listed: c.listed, userId: c.userId }] : [])),
  );
  if (resolutions.length === 0) return null;

  const org = await db.organisation.findUnique({ where: { id: q.orgId }, select: { language: true, adminGroupId: true, adminChannelMode: true } });
  const lang = org?.language ?? null;
  const s = t(lang);
  const phoneOf = new Map(memberships.map((m) => [m.user.id, m.user.phoneNumber]));
  const { nameMemberFromList } = await import("./month-seed-match");
  const done: string[] = [];
  // Joined a month under way for the games left (review of #611, item 9).
  const leftOnly: string[] = [];
  const failed: string[] = [];
  const settled = new Set<string>();
  for (const r of resolutions) {
    try {
      if (r.kind === "merge") {
        // The new player made for the name IS this member: folded into him
        // with the user-merge tool, which keeps the member's id and phone,
        // moves the month's row and the squad place, and makes the name an
        // alias. Planned first: a blocker (two payments, two logins) writes
        // nothing and is reported.
        const { applyUserMerge } = await import("./user-merge");
        const res = await applyUserMerge(db, r.fromUserId, r.toUserId, { now, actorUserId: userId, actorKind: "admin" });
        if (!res.ok) {
          console.warn(`[month-newcomers] merge ${r.fromUserId} -> ${r.toUserId} blocked: ${res.plan.blockers.join("; ")}`);
          failed.push(r.name);
          continue;
        }
      } else {
        // Nobody was added for the name: this member joins with its line.
        const j = await joinMonthAsOrganiser({ orgId: q.orgId, monthId: q.monthId, userId: r.userId, line: r.line, organiserUserId: userId, words: input.text, now });
        if (!j.ok) {
          failed.push(r.name);
          continue;
        }
        if (j.covered?.leftOnly) leftOnly.push(r.name);
      }
      const to = r.kind === "merge" ? r.toUserId : r.userId;
      await nameMemberFromList(q.orgId, to, r.name);
      settled.add(r.ref);
      done.push(s.mwk_dm_newcomer_is({ name: r.name, phone: formatPhoneForDisplay(phoneOf.get(to) ?? "") }));
    } catch (err) {
      console.error(`[month-newcomers] settling ${r.name} failed:`, err instanceof Error ? err.message : "failed");
      failed.push(r.name);
    }
  }

  // The names still open are asked again in the same DM, renumbered.
  const left = q.names.filter((n) => !settled.has(n.ref));
  const again = left.length > 0 ? await questionText(q.orgId, lang, q.monthId, left) : null;
  const leftLine = leftOnly.length > 0 ? [gamesLeftNote(lang, leftOnly, await monthLabelOf(q.monthId, lang), hasOrganisersGroup(org))] : [];
  const text = [s.mwk_dm_newcomers_done({ done, failed, link: appUrl("/admin/players") }), ...leftLine, ...(again ? ["", again.text] : [])].join("\n").trim();
  const next: NewcomerQuestion | null = again ? { ...q, dm: text, names: left, nameless: again.nameless } : null;
  await db.sentNotification.update({
    where: { id: row.id },
    data: next ? { text: JSON.stringify(next) } : { kind: `${NEWCOMER_ASK_KIND}-closed` },
  });
  if (input.replyPhone && text) await dm(q.orgId, input.replyPhone, text, now);
  return { handled: "month-newcomers-matched", matched: done.length, failed: failed.length };
}

// ── A tagged request: "@Match Time add Tom to the November list" ──────

export type MonthAddOutcome =
  | "month-add-done"
  | "month-add-asked"
  | "month-add-already"
  | "month-add-unclear"
  | "month-add-no-month"
  | "month-add-not-organiser"
  | "month-add-failed"
  // Already on the month, and the words said what he covers (2026-11-16).
  | "month-coverage-done"
  | "month-coverage-same"
  | "month-coverage-confirm"
  | "month-coverage-failed";

export interface MonthAddResult {
  outcome: MonthAddOutcome;
  /** What to say where he asked (HQ or his DM). The players' group gets
   *  only the ✅ (`changed`); the organiser's own DM carries any question. */
  replyText: string | null;
  changed: boolean;
  /** `replyText` ends with "whole month, or just the games left?" about
   *  this regular (2026-11-16): the caller logs it as MatchTime's question
   *  (`askCoverageInHq`) so the answer is read against it. */
  coverageAsk?: { monthId: string; userId: string };
  /** The reply ends with the "added for the games left" line (a door with
   *  no coverage question): the players' group DMs it to the organiser. */
  gamesLeftNote?: boolean;
}

/**
 * An "add" the monthly reader read ("@Match Time add Tom to the November
 * list, he's paid"), from `senderUserId`, in any door. Only an organiser's
 * is acted on; anybody else is told so by DM (`tellRefused`) and nothing
 * is added. The same rules as his re-posted list's new line.
 */
export async function applyMonthAdd(p: {
  orgId: string;
  reading: Extract<MonthlyReading, { kind: "add" }>;
  senderUserId: string;
  sourceRef: string;
  /** Tell a non-organiser by DM (the groups); a DM door answers itself. */
  tellRefused?: boolean;
  /** The players' group says nothing: what did not work is DMed to the
   *  organiser instead (HQ and a DM answer where he asked). */
  tellOrganiser?: boolean;
  /** Asked by DM: any "who is this?" question IS the answer (one DM), and
   *  `replyText` is null when it was sent. */
  viaDm?: boolean;
  now?: Date;
  /** The message, for who-is-who to read an unplaced name in. */
  text?: string;
  /** Tests: who-is-who. Absent: `personPickerFor`. */
  identify?: import("./pipeline/who-is-who").PersonPicker;
  /**
   * A month already under way (2026-11-16, Kemal): whether the words say
   * he covers the whole month or the games left, as the admin extractor
   * reads them (`month_coverage`'s `coverage`); null when they say
   * neither, and the reply then asks. Called only for a regular put on a
   * month that has started. Absent (the players' group, a DM): the games
   * left, as before.
   */
  readCoverage?: () => Promise<CoverageRead>;
}): Promise<MonthAddResult> {
  const res = await addToMonth(p);
  if (p.tellOrganiser && (["month-add-unclear", "month-add-no-month", "month-add-failed"].includes(res.outcome) || res.gamesLeftNote) && res.replyText) {
    try {
      const u = await db.user.findUnique({ where: { id: p.senderUserId }, select: { phoneNumber: true } });
      if (u?.phoneNumber) await dm(p.orgId, u.phoneNumber, res.replyText, p.now ?? new Date());
    } catch (err) {
      console.error("[month-newcomers] telling the organiser failed:", err);
    }
  }
  return res;
}

async function addToMonth(p: Parameters<typeof applyMonthAdd>[0]): Promise<MonthAddResult> {
  const now = p.now ?? new Date();
  const { reading } = p;
  const org = await db.organisation.findUnique({ where: { id: p.orgId }, select: { language: true, adminGroupId: true, adminChannelMode: true } });
  const lang = org?.language ?? null;
  const s = t(lang);
  // The month's name only (any year names it the same).
  const monthWord = monthNameLabel(lang, new Date(Date.UTC(now.getUTCFullYear(), reading.month - 1, 15)));
  const [sender, memberships, aliases] = await Promise.all([
    db.membership.findFirst({ where: { orgId: p.orgId, userId: p.senderUserId, leftAt: null, ...ORDINARY_MEMBER_WHERE }, select: { role: true, user: { select: { phoneNumber: true } } } }),
    db.membership.findMany({
      where: { orgId: p.orgId, leftAt: null, ...ORDINARY_MEMBER_WHERE, user: { isActive: true } },
      select: { user: { select: { id: true, name: true } } },
    }),
    db.userAlias.findMany({ where: { orgId: p.orgId }, select: { userId: true, alias: true } }),
  ]);
  const organiser = sender?.role === "OWNER" || sender?.role === "ADMIN";
  if (!organiser) {
    const text = s.mwk_month_add_not_organiser({ month: monthWord });
    if (p.tellRefused && sender?.user.phoneNumber) {
      try {
        const day = formatLondon(now, "yyyy-MM-dd");
        await db.sentNotification.create({ data: { key: `org-${p.orgId}:month-add-refused:${p.senderUserId}:${day}`, kind: "month-add-refused" } });
        await dm(p.orgId, sender.user.phoneNumber, text, now);
      } catch (err) {
        if (!isUniqueViolation(err)) console.error("[month-newcomers] refusal DM failed:", err);
      }
    }
    return { outcome: "month-add-not-organiser", replyText: text, changed: false };
  }

  const { loadLiveMonths } = await import("./month-signup");
  const month = (await loadLiveMonths(p.orgId, now)).find((m) => m.monthNumber === reading.month);
  if (!month) return { outcome: "month-add-no-month", replyText: s.mwk_month_add_no_month({ month: monthWord }), changed: false };
  const label = monthNameLabel(lang, month.firstKickoff);
  const roster = memberships.map((m) => ({ userId: m.user.id, name: m.user.name, aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias) }));
  // The reader's "" means nobody, or a name two members could be. Before a
  // NEW person is made, who-is-who tells the two apart, with the message
  // (2026-11-09, review of #574; it used to be a name lookup in code that
  // could overrule the reader): a member it is sure of is that member,
  // nobody is a newcomer, anything else is asked about, never guessed.
  let memberId = reading.person.memberId;
  let ambiguous = false;
  if (!memberId && reading.person.name) {
    const { identifyRefs, personPickerFor } = await import("./pipeline/identify-batch");
    const { people } = await identifyRefs({
      picker: p.identify ?? personPickerFor(),
      refs: [reading.person.name],
      body: p.text ?? reading.person.name,
      author: null,
      senderUserId: p.senderUserId,
      roster: roster.map((m) => ({ userId: m.userId, name: m.name ?? "", aliases: m.aliases, isAdmin: false, hasPhone: false })),
      where: "the club's groups: an organiser adds somebody to the month's list",
    });
    const pick = people.get(refKey(reading.person.name));
    if (pick?.kind === "member" && roster.some((m) => m.userId === pick.userId)) memberId = pick.userId;
    else ambiguous = pick?.kind !== "none";
  }
  const onMonth = new Set(month.members.filter((m) => !m.out).map((m) => m.userId));
  const c = classifyNewcomer({ memberId, name: reading.person.name, ambiguous, roster, onMonth });
  const line: NewcomerLine = {
    payg: reading.choice === "payg",
    paygDays: reading.days,
    paid: reading.paid,
    paidPence: reading.paidPence,
    games: reading.games,
  };
  const name = reading.person.name || roster.find((m) => m.userId === memberId)?.name || "";
  const nextDay = (() => {
    const k = month.kickoffs.find((x) => x.getTime() > now.getTime());
    return k ? Number(formatLondon(k, "d")) : null;
  })();
  // A REGULAR PUT ON A MONTH ALREADY UNDER WAY (2026-11-16, Kemal): he
  // covers the whole month (paid it, from the same list as the others) or
  // the games left, as his words say (the admin extractor's read, never
  // code's). Neither said: he joins for the games left and the reply asks.
  // Doors with no reader (a DM, the players' group) say how to change it.
  const view =
    p.readCoverage && !line.payg && c.kind !== "unclear" ? await (await import("./month-member-coverage")).loadCoverageView(month.id, now) : null;
  // Only when the choice means anything: fewer games left than the month's
  // playable games (round 4, item 6: with a week called off, the games left
  // can be every game still on, and then there is nothing to choose).
  const choose = !!view?.started && view.month.gamesLeft < view.month.playable;
  const read = choose ? await p.readCoverage!().catch((): CoverageRead => ({ coverage: null, refs: [] })) : null;
  // Only coverage words about HIM (round 4, item 3): with somebody else
  // named too, none is applied to him, and the reply says the others were
  // left alone (they are changed by a message of their own).
  const memberName = roster.find((m) => m.userId === memberId)?.name ?? "";
  // The same quoted words of the one message (two reads of it may differ
  // in case only). Not a match of names: anything else is "somebody else",
  // and he gets no coverage from them, the safe side.
  const sameQuote = (a: string, b: string) => refKey(a).toLocaleLowerCase() === refKey(b).toLocaleLowerCase();
  const forHim = read ? coverageForAdded(read, [reading.person.name, memberName], sameQuote) : { coverage: null, others: [] };
  const coverage = forHim.coverage;
  const othersLine = forHim.others.length > 0 ? `\n${monthSetupCopy(lang).hq_cover_others({ names: forHim.others.join(", "), first: forHim.others[0] })}` : "";
  if (coverage) line.coverage = coverage;

  if (c.kind === "on-month") {
    // Already on it, and the words say what he covers: that is the change.
    // Never a payment (round 4, option a): "he's paid" for somebody already
    // on the month records nothing, as before this feature; what he paid,
    // or says he paid, is kept and the reply says what that leaves.
    if (coverage) {
      // In the organisers' group a change that affects money waits for YES
      // (Kemal, 2026-11-18); elsewhere it applies as before.
      const { applyCoverage, askCoverageChangeInHq, proposeOrApplyCoverage } = await import("./month-coverage-words");
      const args = { orgId: p.orgId, lang, monthId: month.id, userId: c.userId, name, monthDate: month.firstKickoff, coverage, now };
      const r = p.readCoverage ? await proposeOrApplyCoverage(args) : await applyCoverage(args);
      if (r.confirm) await askCoverageChangeInHq({ orgId: p.orgId, change: r.confirm, text: `${r.replyText}${othersLine}`, now });
      return {
        outcome:
          r.outcome === "month-coverage-done"
            ? "month-coverage-done"
            : r.outcome === "month-coverage-same"
              ? "month-coverage-same"
              : r.outcome === "month-coverage-confirm"
                ? "month-coverage-confirm"
                : "month-coverage-failed",
        replyText: `${r.replyText}${othersLine}`,
        changed: r.outcome === "month-coverage-done",
      };
    }
    return { outcome: "month-add-already", replyText: `${s.mwk_month_add_already({ name, month: label })}${othersLine}`, changed: false };
  }
  if (c.kind === "unclear") return { outcome: "month-add-unclear", replyText: s.mwk_month_add_unclear({ name: name || "?" }), changed: false };
  if (c.kind === "ask") {
    const asked = await askWhoTheyAre({ orgId: p.orgId, monthId: month.id, organiserUserId: p.senderUserId, sourceRef: p.sourceRef, names: [{ name, userId: null, line }], now });
    if (asked && p.viaDm) return { outcome: "month-add-asked", replyText: null, changed: false };
    return { outcome: "month-add-asked", replyText: asked ? s.mwk_month_add_waiting({ name, month: label }) : s.mwk_month_add_unclear({ name }), changed: false };
  }
  const userId = c.kind === "join" ? c.userId : await createNewcomer(p.orgId, name);
  if (!userId) return { outcome: "month-add-failed", replyText: s.mwk_month_add_unclear({ name }), changed: false };
  const j = await joinMonthAsOrganiser({ orgId: p.orgId, monthId: month.id, userId, line, organiserUserId: p.senderUserId, weekDay: nextDay, words: p.text ?? null, now });
  if (!j.ok) return { outcome: "month-add-failed", replyText: s.mwk_month_add_unclear({ name }), changed: false };
  // The reply says what his row says, never what was asked for (review item 4).
  const whole = j.outcome === "regular" && !!j.covered?.whole;
  const games = whole ? j.covered!.playable : (j.covered?.games ?? j.gamesLeft);
  // The words did not say, in HQ: ONE question, at the end of the reply,
  // logged by the caller. Elsewhere: one line saying how to change it.
  const ask = choose && !coverage && j.outcome === "regular" && !whole;
  const note = !p.readCoverage && j.covered?.leftOnly ? `\n${gamesLeftNote(lang, [name], label, hasOrganisersGroup(org))}` : "";
  // A coverage his words asked for and that was refused is said so (round
  // 4, item 5): nothing of it, nor the claim, was written.
  const refusedLine = j.coverageRefused ? `\n${monthSetupCopy(lang).hq_cover_failed({ key: j.coverageRefused, name, month: label })}` : "";
  const done = `${s.mwk_month_add_done({ name, month: label, games, paid: line.paid && !j.coverageRefused, payg: line.payg, whole })}${note}${refusedLine}${othersLine}`;
  let replyText: string | null = done;
  // The players' group DMs the organiser the note (`tellOrganiser`); with a
  // "who is this?" DM too, the note rides in it: ONE DM (round 2, item 3).
  let noteFolded = false;
  if (c.kind === "new") {
    const foldNote = !p.viaDm && !!p.tellOrganiser && !!note;
    const asked = await askWhoTheyAre({
      orgId: p.orgId,
      monthId: month.id,
      organiserUserId: p.senderUserId,
      sourceRef: p.sourceRef,
      names: [{ name, userId, line }],
      prefix: p.viaDm ? done : foldNote ? note.trim() : null,
      now,
    });
    if (asked) replyText = p.viaDm ? null : `${done}\n${s.mwk_month_add_asked({ name })}`;
    noteFolded = asked && foldNote;
  }
  // The words did not say: ONE question, at the end of the reply. The
  // caller logs it as MatchTime's, so the answer is read against it.
  let coverageAsk: MonthAddResult["coverageAsk"];
  if (ask && view && replyText !== null) {
    const { coverageQuestionText } = await import("./month-coverage-words");
    replyText = `${replyText}\n\n${coverageQuestionText({ lang, name, monthDate: month.firstKickoff, month: view.month })}`;
    coverageAsk = { monthId: month.id, userId };
  }
  console.log(`[month-newcomers] ${p.sourceRef}: ${c.kind} ${name} (${userId}) on ${month.id} by ${p.senderUserId}: ${j.outcome}${coverage ? `, covers ${coverage}` : coverageAsk ? ", asked what he covers" : ""}`);
  return { outcome: "month-add-done", replyText, changed: true, ...(coverageAsk ? { coverageAsk } : {}), ...(note && !noteFolded ? { gamesLeftNote: true } : {}) };
}

// ── The same request by DM ────────────────────────────────────────────

/**
 * An ORGANISER of exactly one club on monthly mode DMs MatchTime "add Tom
 * to the November list, he's paid" (2026-11-03). Read by the monthly
 * reader, the step that reads the same words in the groups; only an "add"
 * acts, and the answer is his DM. Anything else, or anybody else, goes on
 * to the other DM handlers. One Haiku call per such DM, none for anybody
 * who is not an organiser of a monthly club.
 */
export async function handleMonthAddDm(input: {
  userId: string;
  text: string;
  authorName: string | null;
  replyPhone: string | null;
  waMessageId: string;
  now: Date;
}): Promise<{ handled: MonthAddOutcome } | null> {
  try {
    const clubs = await db.membership.findMany({
      where: { userId: input.userId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
      select: { org: { select: { id: true, squadMode: true } } },
    });
    const { normaliseSquadMode } = await import("./squad-month-rules");
    const monthly = clubs.filter((c) => normaliseSquadMode(c.org.squadMode) === "monthly");
    if (monthly.length !== 1 || !input.text.trim()) return null;
    const orgId = monthly[0].org.id;
    const { loadMonthlyReaderContext, readMonthlyMessage } = await import("./monthly-reader");
    const { withOrgAiBudget } = await import("./ai-budget");
    const reading = await withOrgAiBudget(orgId, async () => {
      const ctx = await loadMonthlyReaderContext({ orgId, matchId: null, now: input.now });
      const me = ctx.members.find((m) => m.userId === input.userId);
      return readMonthlyMessage(
        { body: input.text, sender: { userId: input.userId, name: me?.name || input.authorName, organiser: true }, history: [], reply: null, now: input.now },
        ctx,
      );
    });
    if (reading.kind !== "add") return null;
    const r = await applyMonthAdd({ orgId, reading, senderUserId: input.userId, sourceRef: input.waMessageId, viaDm: true, now: input.now, text: input.text });
    // His answer (null when the "who is this?" DM already is it).
    if (input.replyPhone && r.replyText) await db.botJob.create({ data: { orgId, kind: "dm", phone: input.replyPhone.replace(/^\+/, ""), text: r.replyText } });
    return { handled: r.outcome };
  } catch (err) {
    console.error("[month-newcomers] add by DM failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
