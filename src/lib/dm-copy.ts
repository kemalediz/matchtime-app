/**
 * PRIVATE MESSAGES, as pure builders (Phase 3 of
 * MDs/multi-language-design-2026-09-16.md).
 *
 * Every DM below used to be a template literal inline in a function that
 * reaches the database (the scheduler, the payment flow, the dm-reply
 * route, a script), which is why the golden snapshot could not pin it.
 * Each one was moved here VERBATIM, in its own commit, and its English
 * was recorded in `copy.en.snap` before any of it moved into the string
 * table. No clock, no database, no model.
 *
 * Rows refer to the design's inventory (section 1.3).
 */
import { gbp } from "./payments";

// ── row 91: the rating-link DM (bot-scheduler.ts and the late one in
//    app/actions/players.ts, which were two copies of one message) ──────

export function buildRatingDm(p: {
  activityName: string;
  /** The match day, "Tue 8 Sep". */
  dateLabel: string;
  mvpLabel: string;
  rateUrl: string;
  statsUrl: string;
}): string {
  return (
    `🏆 *${p.activityName}* — ${p.dateLabel}\n\n` +
    `Rate your teammates and pick ${p.mvpLabel}. Takes ~1 minute.\n\n` +
    `Your personal link:\n${p.rateUrl}\n\n` +
    `Link expires in 5 days.\n\n` +
    `📊 Your season stats (ratings, MoM, badges, share card) — any time:\n${p.statsUrl}`
  );
}

// ── row 92: the daily rating reminder, five day-toned variants ─────────

/**
 * Copy for the daily 18:00 rating-reminder DM. Varies tone by day so five
 * nudges in a row don't all read the same. Each message:
 *   - Opens warmly (first name if we have it).
 *   - Names the match so they remember which one.
 *   - Reminds them why ratings matter (better-balanced teams next week).
 *   - Signs off with the personal magic link.
 * Never guilty or whiny — the goal is to make it feel like a teammate
 * tapping them on the shoulder, not a debt collector.
 */
export function buildRatingReminderDm(args: {
  dayNum: number;
  playerName: string | null;
  activityName: string;
  mvpLabel: string;
  url: string;
}): string {
  const { dayNum, playerName, activityName, mvpLabel, url } = args;
  const first = playerName?.split(/\s+/)[0] ?? "mate";
  const sig = `\n${url}`;
  switch (dayNum) {
    case 1:
      return (
        `Hey ${first} 👋 — hope last night's *${activityName}* was a good one.\n\n` +
        `When you have a sec, tap here to rate your teammates and pick ${mvpLabel}. ` +
        `The more of us vote, the better the teams balance next week 🙌${sig}`
      );
    case 2:
      return (
        `${first}, friendly nudge 🙂 — still waiting on your ratings for *${activityName}*.\n\n` +
        `Literally 30 seconds, promise. Helps everyone get fairer teams next week ⚽${sig}`
      );
    case 3:
      return (
        `Halfway through the rating window, ${first} ⏳\n\n` +
        `Your vote for *${activityName}* actually moves ratings a lot when half the squad has voted ` +
        `and you haven't. Quick tap:${sig}`
      );
    case 4:
      return (
        `${first} — two days left to rate *${activityName}* and lock in ${mvpLabel} 🏆\n\n` +
        `30 seconds, then you're done:${sig}`
      );
    default: // day 5 — last chance
      return (
        `Last call ${first} 🔔 — the rating window for *${activityName}* closes tomorrow.\n\n` +
        `Drop a rating + ${mvpLabel} pick before it shuts. Your voice counts:${sig}`
      );
  }
}

// ── row 83: the tentative ("maybe") follow-up DM ───────────────────────

export function buildTentativeFollowupDm(p: {
  playerName: string | null;
  activityName: string;
  /** "Tue 8 Sep at 21:30", London. */
  whenLabel: string;
}): string {
  const firstName = (p.playerName ?? "there").split(" ")[0];
  return (
    `Hi ${firstName} 👋 You were a *maybe* for *${p.activityName}* on ${p.whenLabel}.\n\n` +
    `Are you in or out? Just reply *IN* or *OUT* and I'll sort the squad 🙏`
  );
}

// ── row 88: the fee ask to the money collector ─────────────────────────

export function buildFeeAskDm(p: {
  collectorName: string | null;
  activityName: string;
  /** Confirmed squad size. 0 omits the "(N played)" clause. */
  headcount: number;
}): string {
  const first = p.collectorName?.split(" ")[0] ?? "there";
  return (
    `💷 ${first} — how much should each player pay for *${p.activityName}*` +
    (p.headcount > 0 ? ` (${p.headcount} played)` : "") +
    `?\n\n` +
    `Just reply with the amount — e.g. "£8 each" or "£80 total to split". ` +
    `I'll confirm, then send everyone their pay link.`
  );
}

// ── row 89: the daily pay chase ────────────────────────────────────────

export function buildPayChaseDm(p: {
  playerName: string | null;
  /** Days since the links went out, 1-based. Picks the opener. */
  dayNum: number;
  fee: number;
  activityName: string;
  url: string;
}): string {
  const first = p.playerName?.split(" ")[0] ?? "there";
  const opener =
    p.dayNum <= 1 ? `Quick one ${first}` : p.dayNum === 2 ? `${first}, gentle nudge` : `${first}, still owed`;
  return (
    `💷 ${opener} — your *${gbp(p.fee)}* for *${p.activityName}* is still outstanding.\n\n` +
    `Pay by bank, card, Apple or Google Pay, or settle directly:\n${p.url}`
  );
}

// ── row 90: the collector's daily "tick off the direct payers" nudge ───

export function buildDirectPayCollectorNudge(p: { count: number; activityName: string; url: string }): string {
  const n = p.count;
  return (
    `🤝 ${n} player${n === 1 ? "" : "s"} said they'd pay you directly for *${p.activityName}*. ` +
    `Tick off whoever's settled up:\n${p.url}`
  );
}

// ── row 95: the pay link ───────────────────────────────────────────────

export function buildPayLinkDm(p: { playerName: string | null; activityName: string; fee: number; url: string }): string {
  const first = p.playerName?.split(" ")[0] ?? "there";
  return (
    `💷 ${first} — match fee for *${p.activityName}* is *${gbp(p.fee)}*.\n\n` +
    `Tap to pay (bank, card, Apple or Google Pay, or pay the organiser directly):\n${p.url}\n\n` +
    `You can also pay for anyone you brought along.`
  );
}

// ── rows 96, 97, 98: the collector fee flow's replies ──────────────────

export function buildFeeReleasedAck(p: { released: number; fee: number; matchName: string }): string {
  const released = p.released;
  return (
    `✅ Done — sent ${released} pay link${released === 1 ? "" : "s"} at *${gbp(p.fee)}* each for *${p.matchName}*. ` +
    `Players can pay by bank, card, Apple or Google Pay, or settle with you directly. I'll chase anyone who hasn't paid.`
  );
}

export function buildFeeCancelledAck(): string {
  return `No problem — cancelled. Just tell me the amount per player when you're ready.`;
}

export function buildFeeConfirmPrompt(p: {
  perPlayer: number;
  headcount: number;
  matchName: string;
  wasTotal: boolean;
}): string {
  const { perPlayer, headcount, matchName, wasTotal } = p;
  const split = wasTotal ? ` (split across ${headcount} player${headcount === 1 ? "" : "s"})` : "";
  return (
    `Got it — *${gbp(perPlayer)}* per player${split} for *${matchName}*` +
    (headcount > 0 ? `, ${headcount} player${headcount === 1 ? "" : "s"} to charge` : "") +
    `.\n\nReply *✅* (or "yes") to send everyone their pay link, or send a different amount to change it.`
  );
}

// ── rows 103, 104: the bench-offer DM's replies (dm-reply route) ───────

export function buildBenchDmUnclear(): string {
  return (
    `Want the open slot for tonight? Reply *YES* to grab it. ` +
    `If not, no worries — you stay on the bench either way 🙏`
  );
}

export type BenchDmAckKind = "declined" | "confirmed" | "taken" | "other";

export function buildBenchDmAck(kind: BenchDmAckKind): string {
  switch (kind) {
    case "declined":
      return `👍 No worries — you're still on the bench, nothing changes.`;
    case "confirmed":
      return `✅ You got it — you're in for tonight! ⚽`;
    case "taken":
      return `Ah — someone just grabbed that one first. You're still first in line on the bench if another opens 🙏`;
    case "other":
      return `👍 Got it.`;
  }
}

// ── row 105: the tentative follow-up's one re-ask ──────────────────────

export function buildTentativeReask(): string {
  return "No worries — just reply *IN* if you can play or *OUT* if you can't, and I'll update the squad 🙏";
}

// ── rows 106, 107, 108: the admin recruit-by-DM reply ──────────────────

export function buildAdminRecruitDmReply(r: {
  ok: boolean;
  reason?: string;
  invited?: number;
  matchName?: string;
  matchWhen?: string;
  need?: number;
}): string {
  return !r.ok
    ? r.reason ?? "Couldn't do that right now."
    : r.invited && r.invited > 0
      ? `📣 Done — DM'd ${r.invited} recent player${r.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${r.matchName}* on ${r.matchWhen}${r.need ? ` (${r.need} spot${r.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`
      : r.reason ??
        `Everyone who played recently has already responded to *${r.matchName}* — nobody new to invite. 👍`;
}

// ── rows 109, 110: the roster check-in replies ─────────────────────────

/** The opening of the clarification, which the route also uses as its
 *  one-per-person dedupe probe. Kept as its own function so the probe and
 *  the message can never drift apart. */
export function rosterSurveyClarificationProbe(firstName: string): string {
  return `Sorry ${firstName} — wasn't sure if that was a reply to the roster check-in`;
}

export function buildRosterSurveyClarification(p: { firstName: string; orgName: string }): string {
  return [
    `${rosterSurveyClarificationProbe(p.firstName)} for *${p.orgName}*.`,
    ``,
    `Was your answer:`,
    `• yes / I'm in`,
    `• maybe / sometimes`,
    `• not for now / out`,
    ``,
    `Quick word back is enough — otherwise no worries, an admin will sort it 🙏`,
  ].join("\n");
}

export function buildRosterSurveyConfirmation(p: { category: "in" | "maybe" | "out"; firstName: string }): string {
  const firstName = p.firstName;
  if (p.category === "in") return `Got it ${firstName}, marked you as in 👍 — thanks!`;
  if (p.category === "maybe") {
    return `Got it ${firstName}, marked you as maybe 👍 — just say *IN* in the group whenever you want to play that week, no need to confirm in advance.`;
  }
  return `No worries ${firstName}, noted you're stepping back. The admins will tidy up the roster at the end of the week. If you change your mind before then, just message back here 🙏`;
}

/** The check-in DM itself (scripts/start-roster-survey.ts). */
export function buildRosterSurveyInviteDm(p: { firstName: string; orgName: string }): string {
  return [
    `Hey ${p.firstName} 👋`,
    ``,
    `This is *Match Time*, the bot that coordinates your *${p.orgName}* WhatsApp group (the Tuesday football one).`,
    ``,
    `Quick check-in — attendance's been thin lately, so we're asking everyone if they're still up for Tuesday football going forward.`,
    ``,
    `Just reply here with a word or two:`,
    `• "yes" / "I'm in" — keep me on the roster`,
    `• "maybe" / "depends" — only when I confirm`,
    `• "not for now" / "out" — step me back`,
    ``,
    `Whatever you pick stays between you and the group admin. No drama 🙏`,
  ].join("\n");
}

// ── row 111: the DM Q&A apology ────────────────────────────────────────

export function buildDmQaApology(): string {
  return "Sorry, I couldn't work that one out — try asking again? 🙂";
}

// ── row 122: the "@Match Time my stats" link DM (analyze route) ────────

export function buildStatsLinkDm(p: { name: string | null; url: string }): string {
  const first = p.name?.split(" ")[0] ?? "there";
  return (
    `📊 Hey ${first} — here are your MatchTime stats: ratings over time, your ` +
    `Man-of-the-Match games, how you compare to the squad, your badges, and a ` +
    `shareable season card.\n\n${p.url}\n\nLink works for 48h.`
  );
}
