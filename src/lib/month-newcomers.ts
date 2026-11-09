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
import { monthNameLabel } from "./i18n/dates";
import { appUrl } from "./app-url";
import { formatPhoneForDisplay } from "./phone";
import { formatLondon } from "./london-time";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import { loadClubQuietHours } from "./club-quiet-hours";
import { nameKey } from "./squad-month-rules";
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
}

/**
 * The person joins the month as the organiser put him on it, exactly as
 * /admin/months "Add a player, Regular" does (or PAYG when the line says),
 * then the line's "says paid" and "4 only". `weekDay`: the day of the
 * game a plain PAYG line is for.
 */
export async function joinMonthAsOrganiser(p: {
  orgId: string;
  monthId: string;
  userId: string;
  line: NewcomerLine;
  organiserUserId: string;
  weekDay?: number | null;
  now: Date;
}): Promise<JoinResult> {
  const { applySignup, commitMonthGames, loadSignupMonth } = await import("./month-signup");
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
    now: p.now,
  });
  if (!res.ok) return { ok: false, changed: false, outcome: null, gamesLeft };
  let changed = res.changed;
  if (res.outcome === "regular") {
    if (p.line.paid) {
      // D3: a claim, never a confirmation; the organiser said it.
      const { claimMonthPaid } = await import("./month-payment");
      if (await claimMonthPaid({ monthId: p.monthId, userId: p.userId, source: "organiser", amountPence: p.line.paidPence, now: p.now })) changed = true;
    }
    if (p.line.games !== null && (await commitMonthGames(p.monthId, p.userId, p.line.games))) changed = true;
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
  return { ok: true, changed, outcome: res.outcome, gamesLeft };
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

  const org = await db.organisation.findUnique({ where: { id: q.orgId }, select: { language: true } });
  const lang = org?.language ?? null;
  const s = t(lang);
  const phoneOf = new Map(memberships.map((m) => [m.user.id, m.user.phoneNumber]));
  const { nameMemberFromList } = await import("./month-seed-match");
  const done: string[] = [];
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
        const j = await joinMonthAsOrganiser({ orgId: q.orgId, monthId: q.monthId, userId: r.userId, line: r.line, organiserUserId: userId, now });
        if (!j.ok) {
          failed.push(r.name);
          continue;
        }
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
  const text = [s.mwk_dm_newcomers_done({ done, failed, link: appUrl("/admin/players") }), ...(again ? ["", again.text] : [])].join("\n").trim();
  const next: NewcomerQuestion | null = again ? { ...q, dm: text, names: left, nameless: again.nameless } : null;
  await db.sentNotification.update({
    where: { id: row.id },
    data: next ? { text: JSON.stringify(next) } : { kind: `${NEWCOMER_ASK_KIND}-closed` },
  });
  if (input.replyPhone && text) await dm(q.orgId, input.replyPhone, text, now);
  return { handled: "month-newcomers-matched", matched: done.length, failed: failed.length };
}

// ── A tagged request: "@Match Time add Tom to the November list" ──────

export type MonthAddOutcome = "month-add-done" | "month-add-asked" | "month-add-already" | "month-add-unclear" | "month-add-no-month" | "month-add-not-organiser" | "month-add-failed";

export interface MonthAddResult {
  outcome: MonthAddOutcome;
  /** What to say where he asked (HQ or his DM). The players' group gets
   *  only the ✅ (`changed`); the organiser's own DM carries any question. */
  replyText: string | null;
  changed: boolean;
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
}): Promise<MonthAddResult> {
  const res = await addToMonth(p);
  if (p.tellOrganiser && ["month-add-unclear", "month-add-no-month", "month-add-failed"].includes(res.outcome) && res.replyText) {
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
  const org = await db.organisation.findUnique({ where: { id: p.orgId }, select: { language: true } });
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

  if (c.kind === "on-month") return { outcome: "month-add-already", replyText: s.mwk_month_add_already({ name, month: label }), changed: false };
  if (c.kind === "unclear") return { outcome: "month-add-unclear", replyText: s.mwk_month_add_unclear({ name: name || "?" }), changed: false };
  if (c.kind === "ask") {
    const asked = await askWhoTheyAre({ orgId: p.orgId, monthId: month.id, organiserUserId: p.senderUserId, sourceRef: p.sourceRef, names: [{ name, userId: null, line }], now });
    if (asked && p.viaDm) return { outcome: "month-add-asked", replyText: null, changed: false };
    return { outcome: "month-add-asked", replyText: asked ? s.mwk_month_add_waiting({ name, month: label }) : s.mwk_month_add_unclear({ name }), changed: false };
  }
  const userId = c.kind === "join" ? c.userId : await createNewcomer(p.orgId, name);
  if (!userId) return { outcome: "month-add-failed", replyText: s.mwk_month_add_unclear({ name }), changed: false };
  const j = await joinMonthAsOrganiser({ orgId: p.orgId, monthId: month.id, userId, line, organiserUserId: p.senderUserId, weekDay: nextDay, now });
  if (!j.ok) return { outcome: "month-add-failed", replyText: s.mwk_month_add_unclear({ name }), changed: false };
  const done = s.mwk_month_add_done({ name, month: label, games: j.gamesLeft, paid: line.paid, payg: line.payg });
  let replyText: string | null = done;
  if (c.kind === "new") {
    const asked = await askWhoTheyAre({
      orgId: p.orgId,
      monthId: month.id,
      organiserUserId: p.senderUserId,
      sourceRef: p.sourceRef,
      names: [{ name, userId, line }],
      prefix: p.viaDm ? done : null,
      now,
    });
    if (asked) replyText = p.viaDm ? null : `${done}\n${s.mwk_month_add_asked({ name })}`;
  }
  console.log(`[month-newcomers] ${p.sourceRef}: ${c.kind} ${name} (${userId}) on ${month.id} by ${p.senderUserId}: ${j.outcome}`);
  return { outcome: "month-add-done", replyText, changed: true };
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
