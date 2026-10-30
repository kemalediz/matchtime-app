/**
 * A CHANGE TO THE TEAMS AS THEY STAND, ASKED IN THE PLAYERS' GROUP
 * (2026-10-30, the "no string parsing" sweep).
 *
 * The teams extractor reads the message (router `balancer`, then
 * `extractForRoute`, the same pipeline the admin group uses since #468)
 * and returns `action: "swap"` with its facts. This module applies the two
 * shapes the players' group has always supported, from those facts and the
 * database, never from the words:
 *
 *   swapSides       the two whole teams swap over: every TeamAssignment
 *                   flips RED and YELLOW, same players, no rebalance (Kemal,
 *                   2026-06-09: "swap the colours and keep the same teams").
 *   two moves       "swap A and B": `planSwap` (team-slot-swap.ts) decides
 *                   from the attendance rows and the sheet: both playing
 *                   exchange sides; a confirmed player with no slot takes
 *                   the slot of a holder who is no longer playing; anything
 *                   else is refused with the reason.
 *
 * Any other change (one name, a named side, a pairing, three or more
 * names) is "unsupported": one line, nothing written, as before.
 *
 * It writes TeamAssignment and nothing else: never attendance, never the
 * balancer.
 */
import { db } from "./db";
import { resolveTeamLabels } from "./team-labels";
import {
  buildColourSwapReply,
  buildSlotTransferReply,
  buildSwapDeferredReply,
  buildSwapRefusedReply,
  buildTeamSheet,
  buildTeamSwapReply,
  teamSheetNames,
} from "./group-copy";
import { planSwap, type SwapCandidate } from "./team-slot-swap";
import { t } from "./i18n/t";

/** The slice of the teams extractor's facts this module reads. */
export interface PlayersSwapFacts {
  moves?: string[];
  swaps: Array<{ personRef: string; team: "RED" | "YELLOW" }>;
  pairings?: string[][];
  swapSides?: boolean;
}

export type PlayersSwapShape =
  | { kind: "swap-sides" }
  | { kind: "two-players"; a: string; b: string }
  | { kind: "unsupported" };

/** PURE. Which of the supported changes the facts ask for. */
export function playersSwapShape(facts: PlayersSwapFacts): PlayersSwapShape {
  if (facts.swapSides === true) return { kind: "swap-sides" };
  const moves = (facts.moves ?? []).map((m) => m.trim()).filter(Boolean);
  const named = facts.swaps.length > 0 || (facts.pairings ?? []).some((g) => g.length > 0);
  if (!named && moves.length === 2) return { kind: "two-players", a: moves[0], b: moves[1] };
  return { kind: "unsupported" };
}

export type PlayersSwapResult =
  | { kind: "applied"; reply: string; logReason: string }
  | { kind: "refused"; reply: string; logReason: string }
  | { kind: "unsupported"; logReason: string };

const ACTIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

async function loadMatch(orgId: string) {
  return db.match.findFirst({
    where: { activity: { orgId }, status: { in: [...ACTIVE] } },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true, language: true } },
        },
      },
      // EVERY attendance row, not only CONFIRMED: a DROPPED holder of a
      // stale slot must be found to hand that slot on (2026-09-08).
      attendances: { include: { user: { select: { id: true, name: true } } } },
      teamAssignments: { include: { user: { select: { id: true, name: true } } } },
    },
  });
}

/**
 * The team sheet as the swap replies print it: sheet order (`id: asc`),
 * and a holder who is no longer CONFIRMED shown as an open slot
 * (2026-09-29, `teamSheetNames`).
 */
async function honestSheetNames(matchId: string, lang: string | null | undefined): Promise<{ red: string[]; yellow: string[] }> {
  const [rows, playing] = await Promise.all([
    db.teamAssignment.findMany({
      where: { matchId },
      orderBy: { id: "asc" },
      select: { userId: true, team: true, user: { select: { name: true } } },
    }),
    db.attendance.findMany({ where: { matchId, status: "CONFIRMED" }, select: { userId: true } }),
  ]);
  return teamSheetNames(
    rows.map((r) => ({ userId: r.userId, team: r.team, name: r.user.name })),
    new Set(playing.map((p) => p.userId)),
    lang,
  );
}

/**
 * Apply a players'-group team change the teams extractor read as `swap`.
 * `sender` is the resolved sender ("me" in the facts is them).
 */
export async function applyPlayersGroupSwap(args: {
  orgId: string;
  facts: PlayersSwapFacts;
  sender: { userId: string; name: string } | null;
}): Promise<PlayersSwapResult> {
  const shape = playersSwapShape(args.facts);
  if (shape.kind === "unsupported") {
    return { kind: "unsupported", logReason: "a change to the teams the players' group does not support (only two players, or the whole teams)" };
  }
  const match = await loadMatch(args.orgId);
  const lang = match?.activity.org.language ?? null;
  if (!match || match.teamAssignments.length === 0) {
    if (shape.kind === "swap-sides") {
      return { kind: "refused", reply: t(lang).swap_refused_teams_not_generated, logReason: "swap the teams over: no teams yet; nothing written" };
    }
    if (!match) return { kind: "unsupported", logReason: "swap: no upcoming match" };
  }
  const labels = resolveTeamLabels(match!, match!.activity.org, match!.activity.sport, lang);
  const sheet = async () => buildTeamSheet({ redLabel: labels[0], yellowLabel: labels[1], ...(await honestSheetNames(match!.id, lang)) });

  if (shape.kind === "swap-sides") {
    // Flip every assignment in one transaction: same players, sides swapped.
    await db.$transaction(
      match!.teamAssignments.map((t) =>
        db.teamAssignment.update({ where: { id: t.id }, data: { team: t.team === "RED" ? "YELLOW" : "RED" } }),
      ),
    );
    return { kind: "applied", reply: buildColourSwapReply({ sheet: await sheet(), lang }), logReason: "the teams swapped over (every slot flipped, same players)" };
  }

  const m = match!;
  const teamOf = new Map(m.teamAssignments.map((t) => [t.userId, t.team]));
  const roster: SwapCandidate[] = [];
  for (const a of m.attendances) {
    if (!a.user.name) continue;
    roster.push({ userId: a.user.id, name: a.user.name, status: a.status, team: teamOf.get(a.user.id) ?? null });
  }
  // A slot holder with no attendance row at all (a hand-edited sheet).
  const seen = new Set(roster.map((r) => r.userId));
  for (const t of m.teamAssignments) {
    if (seen.has(t.userId) || !t.user.name) continue;
    roster.push({ userId: t.userId, name: t.user.name, status: "NONE", team: t.team });
  }

  const plan = planSwap({ a: shape.a, b: shape.b }, roster, { sender: args.sender, teamsExist: m.teamAssignments.length > 0 });
  if (plan.kind === "not-a-player-swap") {
    return { kind: "unsupported", logReason: `swap ${shape.a} and ${shape.b}: neither is a player of this match, or it is a substitution of the sender` };
  }
  if (plan.kind === "refused") {
    return {
      kind: "refused",
      reply: buildSwapRefusedReply({ a: plan.a, b: plan.b, why: plan.why, lang }),
      logReason: `team-swap refused (${plan.why.reason}): ${plan.a} <-> ${plan.b}; nothing written`,
    };
  }
  const decision = plan.decision;
  if (decision.kind === "defer-no-teams") {
    return {
      kind: "applied",
      reply: buildSwapDeferredReply({ a: decision.a.name, b: decision.b.name, lang }),
      logReason: `team-swap deferred (no teams yet): ${decision.a.name} <-> ${decision.b.name}`,
    };
  }
  if (decision.kind === "team-swap") {
    await db.$transaction([
      db.teamAssignment.upsert({
        where: { matchId_userId: { matchId: m.id, userId: decision.a.userId } },
        create: { matchId: m.id, userId: decision.a.userId, team: decision.teamForA },
        update: { team: decision.teamForA },
      }),
      db.teamAssignment.upsert({
        where: { matchId_userId: { matchId: m.id, userId: decision.b.userId } },
        create: { matchId: m.id, userId: decision.b.userId, team: decision.teamForB },
        update: { team: decision.teamForB },
      }),
    ]);
    return {
      kind: "applied",
      reply: buildTeamSwapReply({ a: decision.a.name, b: decision.b.name, sheet: await sheet(), lang }),
      logReason: `team-swap applied: ${decision.a.name} <-> ${decision.b.name}`,
    };
  }
  // The replacement: one slot moves from a player who is not coming to a
  // confirmed player with none. Delete and upsert together, so the sheet is
  // never a player short nor two people in one seat. No attendance write.
  await db.$transaction([
    db.teamAssignment.delete({ where: { matchId_userId: { matchId: m.id, userId: decision.from.userId } } }),
    db.teamAssignment.upsert({
      where: { matchId_userId: { matchId: m.id, userId: decision.to.userId } },
      create: { matchId: m.id, userId: decision.to.userId, team: decision.team },
      update: { team: decision.team },
    }),
  ]);
  return {
    kind: "applied",
    reply: buildSlotTransferReply({
      to: decision.to.name,
      from: decision.from.name,
      teamLabel: decision.team === "RED" ? labels[0] : labels[1],
      sheet: await sheet(),
      lang,
    }),
    logReason: `team-slot-transfer applied: ${decision.from.name} (${decision.from.status}) -> ${decision.to.name} on ${decision.team}`,
  };
}
