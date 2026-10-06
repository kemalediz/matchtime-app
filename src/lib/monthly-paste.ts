/**
 * Monthly squad, slice 5: a member's pasted list, applied (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, section 6.2, decisions D3
 * and D4.
 *
 * In a group that runs on a monthly list almost every change is a
 * re-pasted list. For a club on "monthly" with a running month, the
 * analyze route hands a list-shaped group message here BEFORE the router
 * (no model reads it):
 *
 *   1. `parseMonthlyList` (slice 1) reads what the message says;
 *   2. `reconcileMonthPaste` (pure) compares it with this week's state BY
 *      NAME and returns what it changes;
 *   3. this file applies that through the ordinary attendance write path
 *      (`registerAttendance`, `cancelAttendance`), so capacity, the
 *      waiting list, the bench/PAYG offer, the slot number and the credit
 *      all behave exactly as for an IN or an OUT typed in the group.
 *
 * D4: a paste may change SOMEBODY ELSE'S line. That player gets a DM
 * naming who did it, with the one word that undoes it.
 * D3: a "(paid)" mark is recorded as "says paid", whoever wrote it. It
 * never sets `paidAt`: only the collector confirms.
 *
 * Returns null when this is not a monthly club's list for this month: the
 * caller then does what it did before monthly mode existed.
 */
import { db } from "./db";
import { cancelAttendance, registerAttendance } from "./attendance";
import { sendAdminNotice } from "./admin-channel";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import { formatLondon } from "./london-time";
import { parseMonthlyList } from "./monthly-list";
import { loadMonthlyWeek, recordWeekListShown, renderWeekList, syncMonthlyWeek } from "./monthly-week";
import {
  buildPasteIgnoredAdminNotice,
  buildPasteNotAddedNotice,
  buildPasteSenderNotListDm,
  buildPasteSenderNotMatchedDm,
  buildPasteUndoDm,
  pasteResidual,
} from "./monthly-week-copy";
import {
  buildWeekList,
  pasteShowsSameList,
  reconcileMonthPaste,
  weekListHash,
  type PasteIgnored,
  type PasteNotAdded,
  type PasteRosterMember,
} from "./monthly-week-rules";

export interface MonthlyPasteResult {
  /** Attendance or payment state changed because of this paste. */
  changed: boolean;
  /** What was applied, for the AnalyzedMessage row. Never parsed. */
  applied: string[];
  /** Lines left alone on purpose (an old copy). */
  ignored: PasteIgnored[];
  /** Names in numbered slots that were NOT registered: nobody's name, two
   *  players' name, or a club player who is not on the month's list. */
  notAdded: PasteNotAdded[];
  /** Names whose write failed. */
  failures: string[];
  /** Whatever the member typed around the list ("can't make it lads"),
   *  for the rest of the pipeline. "" when the message was only a list. */
  residual: string;
}

/**
 * A list-shaped message in a monthly club's running month that is NOT the
 * month's list (another month's header, or a numbered list of something
 * else: "Kit for Monday: 1. Bibs 2. Two balls"). Nothing is read from it,
 * and the caller must not let any other path register its lines either.
 */
export interface NotThisMonthsList {
  notThisList: true;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Claim a once-only key. False when it was already claimed. */
async function claimOnce(key: string, kind: string, matchId: string | null): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind, ...(matchId ? { matchId } : {}) } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Apply a member's pasted list to this week's match.
 *
 * NEVER creates a player and never guesses one: names are matched by the
 * pure resolver in `reconcileMonthPaste` (whole name, a known alias, the
 * leading name) and by nothing else. The analyze route's own resolver,
 * which matches by prefix and provisions a new member for a name it does
 * not know, is deliberately not reachable from here: it turned "Kit for
 * Monday / 1. Bibs / 2. Two balls" into players (review, 2026-10-06).
 *
 * Returns null when there is nothing monthly about this message (not
 * list-shaped, a weekly club, no running month for the match), and
 * `{ notThisList: true }` when it is a list but not this month's.
 */
export async function handleMonthlyPaste(args: {
  orgId: string;
  matchId: string;
  body: string;
  waMessageId: string;
  /** When the member sent it (the original WhatsApp time). */
  sentAt?: Date;
  sender: { userId: string | null; name: string | null };
  /** The sender's WhatsApp name, beside their club name: a line they add
   *  for themselves may be written under either. */
  senderWhatsAppName?: string | null;
  now?: Date;
}): Promise<MonthlyPasteResult | NotThisMonthsList | null> {
  const { orgId, matchId, sender } = args;
  const now = args.now ?? new Date();
  const list = parseMonthlyList(args.body);
  if (!list) return null;
  const week = await loadMonthlyWeek(matchId);
  if (!week || week.orgId !== orgId) return null;

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId, leftAt: null, user: { isActive: true } },
      select: { role: true, user: { select: { id: true, name: true, phoneNumber: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const roster: PasteRosterMember[] = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias),
  }));
  const senderRole = sender.userId ? memberships.find((m) => m.user.id === sender.userId)?.role : null;
  const senderIsAdmin = senderRole === "OWNER" || senderRole === "ADMIN";

  const outcome = reconcileMonthPaste({
    list,
    members: week.members,
    rows: week.rows,
    maxPlayers: week.maxPlayers,
    roster,
    matchMonth: Number(formatLondon(week.matchDate, "M")),
    // Before the regulars are on the match (the hours after one game ends)
    // a paste only records paid marks.
    seeded: week.seeded,
    senderUserId: sender.userId,
    senderNames: [sender.name, args.senderWhatsAppName],
    senderIsAdmin,
  });

  const phoneOf = new Map(memberships.map((m) => [m.user.id, m.user.phoneNumber]));
  const memberOf = new Map(week.members.map((m) => [m.userId, m]));
  const rowOf = new Map(week.rows.map((r) => [r.userId, r]));
  const sendAfter = adminNoticeSendAfter(now);
  const day = formatLondon(now, "yyyy-MM-dd");
  const dm = (phone: string, text: string) =>
    db.botJob.create({
      // Never between 22:00 and 07:59 London: held until 08:00.
      data: { orgId, kind: "dm", phone: phone.replace(/^\+/, ""), text, ...(sendAfter ? { sendAfter } : {}) },
    });
  /** A DM to the SENDER about their own paste, at most once a day per
   *  kind: nothing is said in the group, but nothing is swallowed either. */
  const tellSender = async (kind: "not-matched" | "not-list", text: string): Promise<void> => {
    const phone = sender.userId ? phoneOf.get(sender.userId) : null;
    if (!sender.userId || !phone) return;
    try {
      if (await claimOnce(`org-${orgId}:month-paste-sender:${kind}:${day}:${sender.userId}`, "paste-sender-dm", null)) await dm(phone, text);
    } catch (err) {
      console.error("[monthly-paste] sender DM failed:", err);
    }
  };

  // "List for November" pasted in October is next month's sign-up
  // (slice 3); a numbered list of something else is not a squad list.
  if (outcome.otherMonth || outcome.notThisList) {
    // A member of the month whose headerless list was not read may have
    // meant the squad list: they are told how to make it readable.
    const m = sender.userId ? memberOf.get(sender.userId) : undefined;
    if (outcome.notThisList && m && !m.left) {
      await tellSender("not-list", buildPasteSenderNotListDm({ matchDate: week.matchDate, lang: week.language }));
    }
    return { notThisList: true };
  }
  /** D4: tell the player whose line somebody else changed. Once per paste
   *  and player, so a retried batch cannot send it twice. */
  const undoDm = async (userId: string, change: "out-paid" | "out" | "in"): Promise<void> => {
    const phone = phoneOf.get(userId);
    if (!phone) return;
    if (!(await claimOnce(`${matchId}:paste-undo:${args.waMessageId}:${userId}`, "paste-undo-dm", matchId))) return;
    await dm(
      phone,
      buildPasteUndoDm({ change, actorName: sender.name, activityName: week.activityName, matchDate: week.matchDate, lang: week.language }),
    );
  };

  const applied: string[] = [];
  const failures: string[] = [];
  for (const a of outcome.actions) {
    try {
      if (a.kind === "in") {
        const before = rowOf.get(a.userId)?.status ?? null;
        const res = await registerAttendance(a.userId, matchId, {
          promoteFromBench: a.self,
          event: {
            cause: "pasted-roster",
            actorKind: a.self ? "player" : "member",
            actorUserId: sender.userId ?? null,
            sourceRef: args.waMessageId,
            note: "written into a numbered slot on a pasted monthly list",
          },
        });
        // Nothing changed (they were in already): nothing to say or undo.
        if (res.status === before) continue;
        applied.push(`in:${a.name}${res.status === "BENCH" ? " (waiting list)" : ""}`);
        if (!a.self) await undoDm(a.userId, "in");
      } else if (a.kind === "out") {
        const member = memberOf.get(a.userId);
        const row = rowOf.get(a.userId);
        if (row) {
          if (row.status === "DROPPED") continue;
          await cancelAttendance(
            a.userId,
            matchId,
            {
              cause: "pasted-roster",
              actorKind: a.self ? "player" : "member",
              actorUserId: sender.userId ?? null,
              sourceRef: args.waMessageId,
              note:
                a.via === "blank"
                  ? "their line was blanked on a pasted monthly list"
                  : "moved under can't play on a pasted monthly list",
            },
            { occurredAt: args.sentAt },
          );
        } else {
          // A regular of a seeded week with no row of their own: away.
          const res = await db.squadMonthMember.updateMany({
            where: { monthId: week.monthId, userId: a.userId, NOT: { absentMatchIds: { has: matchId } } },
            data: { absentMatchIds: { push: matchId } },
          });
          if (res.count === 0) continue;
        }
        applied.push(`out:${a.name}`);
        if (!a.self) await undoDm(a.userId, member?.kind === "regular" && member.paid !== "none" ? "out-paid" : "out");
      } else {
        // D3. A claim, never a confirmation: `paidAt` is not touched, and
        // a row that already says paid (or is confirmed) is left alone.
        const res = await db.squadMonthMember.updateMany({
          where: { monthId: week.monthId, userId: a.userId, paidAt: null, paidClaimedAt: null },
          data: {
            paidClaimedAt: now,
            paidClaimSource: a.self ? "list" : "other-player",
            paidClaimedAmountPence: a.amountPence,
          },
        });
        if (res.count > 0) applied.push(`says-paid:${a.name}`);
      }
    } catch (err) {
      console.error(`[monthly-paste] ${a.kind} for "${a.name}" on ${matchId} failed:`, err);
      failures.push(a.name);
    }
  }

  // A paid claim can turn a drop into a credit; the attendance path has
  // already run the sync for the rest.
  await syncMonthlyWeek(matchId, now).catch((err) => console.error("[monthly-paste] sync failed:", err));

  // An old copy was pasted: one line to the organisers, at most once a
  // London day per club.
  if (outcome.ignored.length > 0) {
    try {
      if (await claimOnce(`org-${orgId}:month-paste-ignored:${day}`, "admin-notice", null)) {
        await sendAdminNotice({
          orgId,
          now,
          text: buildPasteIgnoredAdminNotice({
            actorName: sender.name,
            names: outcome.ignored.map((i) => i.name),
            matchDate: week.matchDate,
            lang: week.language,
          }),
        });
      }
    } catch (err) {
      console.error("[monthly-paste] old-copy notice failed:", err);
    }
  }

  // Names that were not added: the admin who pasted them is told, else the
  // organisers, with how to add a player. Once a day for the same names
  // (this group re-pastes its list all day long).
  if (outcome.notAdded.length > 0) {
    try {
      const names = [...new Set(outcome.notAdded.map((n) => n.name))];
      const key = `org-${orgId}:month-paste-not-added:${day}:${weekListHash(names.map((n) => n.toLowerCase()).sort().join("|"))}`;
      if (await claimOnce(key, "admin-notice", null)) {
        const text = buildPasteNotAddedNotice({ actorName: sender.name, names, matchDate: week.matchDate, lang: week.language });
        const own = senderIsAdmin && sender.userId ? phoneOf.get(sender.userId) : null;
        if (own) await dm(own, text);
        else await sendAdminNotice({ orgId, now, text });
      }
      // And the sender is told too (an admin has just had the note).
      if (!senderIsAdmin) {
        await tellSender("not-matched", buildPasteSenderNotMatchedDm({ names, lang: week.language }));
      }
    } catch (err) {
      console.error("[monthly-paste] not-added notice failed:", err);
    }
  }

  // The group has just seen this list: when it is the list as MatchTime
  // now has it, record that, so the scheduler does not post it straight
  // back (plan 5.4: "no re-post after a member's paste that matches").
  try {
    const after = await loadMonthlyWeek(matchId);
    if (after?.seeded) {
      const weekList = buildWeekList({ members: after.members, rows: after.rows, maxPlayers: after.maxPlayers });
      if (pasteShowsSameList({ list, week: weekList, roster })) {
        await recordWeekListShown(matchId, renderWeekList(after).hash, "month-list-seen");
      }
    }
  } catch (err) {
    console.error("[monthly-paste] could not record the list as seen (it will be posted):", err);
  }

  return {
    changed: applied.length > 0,
    applied,
    ignored: outcome.ignored,
    notAdded: outcome.notAdded,
    failures,
    residual: pasteResidual(args.body, { lang: week.language, maxPlayers: week.maxPlayers, paygPricePence: week.paygPricePence }),
  };
}
