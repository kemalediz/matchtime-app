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
import { buildPasteIgnoredAdminNotice, buildPasteUndoDm, pasteResidual } from "./monthly-week-copy";
import {
  buildWeekList,
  pasteShowsSameList,
  reconcileMonthPaste,
  type PasteIgnored,
  type PasteRosterMember,
} from "./monthly-week-rules";

export interface MonthlyPasteResult {
  /** Attendance or payment state changed because of this paste. */
  changed: boolean;
  /** What was applied, for the AnalyzedMessage row. Never parsed. */
  applied: string[];
  /** Lines left alone on purpose (an old copy, an ambiguous name). */
  ignored: PasteIgnored[];
  /** Names whose write failed or that could not be resolved. */
  failures: string[];
  /** Whatever the member typed around the list ("can't make it lads"),
   *  for the rest of the pipeline. "" when the message was only a list. */
  residual: string;
}

/** `UserAlias.alias` is stored normalised, as the analyze route reads it. */
function aliasKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export async function handleMonthlyPaste(args: {
  orgId: string;
  matchId: string;
  body: string;
  waMessageId: string;
  /** When the member sent it (the original WhatsApp time). */
  sentAt?: Date;
  sender: { userId: string | null; name: string | null };
  /** The analyze route's own name resolver (exact, first name, alias,
   *  then a provisional member). Used only for a name nobody here has. */
  resolveByName: (name: string) => Promise<{ userId: string; name: string | null } | null>;
  now?: Date;
}): Promise<MonthlyPasteResult | null> {
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
    senderUserId: sender.userId,
    senderIsAdmin,
  });
  // "List for November" pasted in October is next month's sign-up
  // (slice 3), not this week's list.
  if (outcome.otherMonth) return null;

  const phoneOf = new Map(memberships.map((m) => [m.user.id, m.user.phoneNumber]));
  const memberOf = new Map(week.members.map((m) => [m.userId, m]));
  const rowOf = new Map(week.rows.map((r) => [r.userId, r]));
  const sendAfter = adminNoticeSendAfter(now);
  /** D4: tell the player whose line somebody else changed. */
  const undoDm = async (userId: string, change: "out-paid" | "out" | "in"): Promise<void> => {
    const phone = phoneOf.get(userId);
    if (!phone) return;
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: phone.replace(/^\+/, ""),
        text: buildPasteUndoDm({
          change,
          actorName: sender.name,
          activityName: week.activityName,
          matchDate: week.matchDate,
          lang: week.language,
        }),
        // Never between 22:00 and 07:59 London: held until 08:00.
        ...(sendAfter ? { sendAfter } : {}),
      },
    });
  };

  const applied: string[] = [];
  const failures: string[] = [];
  for (const a of outcome.actions) {
    try {
      if (a.kind === "in") {
        const target = a.userId ? { userId: a.userId } : await args.resolveByName(a.name);
        if (!target) {
          failures.push(a.name);
          continue;
        }
        if (a.teachAlias) {
          const alias = aliasKey(a.teachAlias);
          if (alias.length >= 2) {
            await db.userAlias
              .create({ data: { orgId, userId: target.userId, alias, source: "auto-detect" } })
              // Somebody already has that alias: leave it with them.
              .catch(() => {});
          }
        }
        const self = target.userId === sender.userId;
        const res = await registerAttendance(target.userId, matchId, {
          promoteFromBench: self,
          event: {
            cause: "pasted-roster",
            actorKind: self ? "player" : "member",
            actorUserId: sender.userId ?? null,
            sourceRef: args.waMessageId,
            note: "written into a numbered slot on a pasted monthly list",
          },
        });
        applied.push(`in:${a.name}${res.status === "BENCH" ? " (waiting list)" : ""}`);
        if (!self) await undoDm(target.userId, "in");
      } else if (a.kind === "out") {
        const self = a.userId === sender.userId;
        const member = memberOf.get(a.userId);
        if (rowOf.has(a.userId)) {
          await cancelAttendance(
            a.userId,
            matchId,
            {
              cause: "pasted-roster",
              actorKind: self ? "player" : "member",
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
          // A regular with no row yet (the week is not seeded): away.
          await db.squadMonthMember.updateMany({
            where: { monthId: week.monthId, userId: a.userId, NOT: { absentMatchIds: { has: matchId } } },
            data: { absentMatchIds: { push: matchId } },
          });
        }
        applied.push(`out:${a.name}`);
        if (!self) await undoDm(a.userId, member?.kind === "regular" && member.paid !== "none" ? "out-paid" : "out");
      } else {
        // D3. A claim, never a confirmation: `paidAt` is not touched, and
        // a row that already says paid (or is confirmed) is left alone.
        const res = await db.squadMonthMember.updateMany({
          where: { monthId: week.monthId, userId: a.userId, paidAt: null, paidClaimedAt: null },
          data: {
            paidClaimedAt: now,
            paidClaimSource: a.userId === sender.userId ? "list" : "other-player",
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
  const stale = outcome.ignored.filter((i) => i.reason === "stale-readd" || i.reason === "blank-by-other");
  if (stale.length > 0) {
    try {
      await db.sentNotification.create({
        data: { key: `org-${orgId}:month-paste-ignored:${formatLondon(now, "yyyy-MM-dd")}`, kind: "admin-notice" },
      });
      await sendAdminNotice({
        orgId,
        now,
        text: buildPasteIgnoredAdminNotice({
          actorName: sender.name,
          names: stale.map((i) => i.name),
          matchDate: week.matchDate,
          lang: week.language,
        }),
      });
    } catch {
      // Already told today (the unique key), or the notice could not be
      // queued. Either way the paste itself has been dealt with.
    }
  }

  // The group has just seen this list: when it is the list as MatchTime
  // now has it, record that, so the scheduler does not post it straight
  // back (plan 5.4: "no re-post after a member's paste that matches").
  try {
    const after = await loadMonthlyWeek(matchId);
    if (after) {
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
    failures,
    residual: pasteResidual(args.body, { lang: week.language, maxPlayers: week.maxPlayers, paygPricePence: week.paygPricePence }),
  };
}
