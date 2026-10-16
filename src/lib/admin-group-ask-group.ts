/**
 * "ASK THE GROUP IF ANYONE CAN PLAY", FROM HQ (2026-10-16).
 *
 * In FNF's admin group an organiser wrote "@Match Time ask in the group if
 * anyone is available" and MatchTime answered "I can't do that from this
 * group": the shared router read it as `admin_ops`, and HQ had no handler
 * for that route. The manager posted the ask by hand.
 *
 * WHO DECIDES WHAT THE MESSAGE IS. The shared router, as for every other
 * HQ message (`admin-group-understand.ts`): its organisers'-group-only
 * route `ask_group`, owned by code like `poster` and `help`. No phrase
 * list, no extractor (there is nothing to extract: the ask is about the
 * next match, and the count comes from the database).
 *
 * WHY NOT `admin_ops` / `recruit`. Traced and measured before building:
 * the shared admin extractor read the FNF message as `other`, and its
 * `recruit` is the players' group's DM blast to recent players
 * (`recruit.ts` `inviteRecentPlayers`, tag-gated because a mass DM risks
 * the WhatsApp account). Widening `recruit` to cover "ask the group" would
 * have changed what that blast fires on in the players' group. From HQ
 * the ask is instead ONE post in the players' group, which reaches the
 * same people at no risk, where they say IN anyway.
 *
 * WHAT IT DOES, for the club's next match (`loadSquadState`, the same
 * state the players' group pipeline reads, so both agree on which match
 * and how many are in):
 *
 *   places open, not asked yet    one post in the players' group
 *                                 (`buildGroupAskPost`, true for the
 *                                 club's pick mode); HQ hears "Asked in the
 *                                 main chat for 1 player."
 *   the same opening asked again  nothing posted; HQ hears when it was
 *                                 asked. Asked once more: posted again.
 *   no place open                 nothing posted; HQ hears the count.
 *
 * The claim (a SentNotification) and the post (a `group` BotJob) are
 * written in one transaction, so two organisers asking at once post once.
 * The post is an ordinary BotJob: a muted or paused club sends nothing.
 *
 * Logs carry ids and counts only.
 */
import { db } from "./db";
import { loadSquadState } from "./pipeline/load-state";
import { formatLondon } from "./london-time";
import { t } from "./i18n/t";
import { buildGroupAskPost, decideGroupAsk, openingFingerprint, type GroupAskStep } from "./admin-group-ask-group-rules";

const CLAIM_KIND = "hq-group-ask";

export interface GroupAskResult {
  outcome: "group-asked" | "group-ask-already" | "group-ask-full" | "group-ask-no-match" | "hq-not-here";
  replyText: string;
}

function parseStep(key: string, prefix: string, at: Date): GroupAskStep | null {
  const [round, step] = key.slice(prefix.length).split(":");
  const n = Number(round);
  if (!Number.isInteger(n) || n < 1 || (step !== "post" && step !== "told")) return null;
  return { step, round: n, at };
}

export async function askPlayersGroup(args: {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  now: Date;
}): Promise<GroupAskResult> {
  const { orgId, messageId, now } = args;
  const s = t(args.lang);
  const state = await loadSquadState(orgId, now);
  if (!state.matchId) return { outcome: "group-ask-no-match", replyText: s.recruit_no_match };
  // A club that does not keep a squad in MatchTime has no count to ask for.
  if (!state.features.attendance || state.maxPlayers <= 0) return { outcome: "hq-not-here", replyText: s.hq_not_here };

  const confirmedIds = state.rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId);
  const prefix = `group-ask:${state.matchId}:${openingFingerprint(confirmedIds)}:`;
  const rows = await db.sentNotification.findMany({
    where: { key: { startsWith: prefix } },
    select: { key: true, createdAt: true },
  });
  const history = rows.map((r) => parseStep(r.key, prefix, r.createdAt)).filter((x): x is GroupAskStep => x !== null);
  const decision = decideGroupAsk({ confirmed: confirmedIds.length, maxPlayers: state.maxPlayers, history });

  if (decision.kind === "full") {
    console.log(`[admin-group] ${messageId}: group ask, squad full (${confirmedIds.length} of ${state.maxPlayers})`);
    return {
      outcome: "group-ask-full",
      replyText: s.hq_group_ask_full({ confirmed: confirmedIds.length, maxPlayers: state.maxPlayers, kickoffLabel: state.kickoffLabel }),
    };
  }

  const already = (open: number, askedAt: Date): GroupAskResult => ({
    outcome: "group-ask-already",
    replyText: s.hq_group_ask_already({ open, at: formatLondon(askedAt, "HH:mm") }),
  });

  if (decision.kind === "already") {
    await db.sentNotification
      .createMany({ data: [{ key: `${prefix}${decision.round}:told`, kind: CLAIM_KIND, matchId: state.matchId }], skipDuplicates: true })
      .catch(() => {});
    console.log(`[admin-group] ${messageId}: group ask, already asked (round ${decision.round})`);
    return already(decision.open, decision.askedAt);
  }

  const text = buildGroupAskPost({
    lang: args.lang,
    pickMode: state.features.benchPickMode,
    kickoffLabel: state.kickoffLabel,
    confirmed: confirmedIds.length,
    maxPlayers: state.maxPlayers,
    open: decision.open,
  });
  const matchId = state.matchId;
  const jobId = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({
      data: [{ key: `${prefix}${decision.round}:post`, kind: CLAIM_KIND, matchId }],
      skipDuplicates: true,
    });
    if (count !== 1) return null;
    const job = await tx.botJob.create({ data: { orgId, kind: "group", text } });
    return job.id;
  });
  if (!jobId) {
    // Another organiser's ask for the same opening landed first.
    console.log(`[admin-group] ${messageId}: group ask, raced (round ${decision.round})`);
    return already(decision.open, now);
  }
  console.log(`[admin-group] ${messageId}: group ask posted, job ${jobId}, ${decision.open} open, round ${decision.round}`);
  return { outcome: "group-asked", replyText: s.hq_group_asked({ open: decision.open }) };
}
