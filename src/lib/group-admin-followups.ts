/**
 * AN ORGANISER FOLLOWING UP MATCHTIME IN THE PLAYERS' GROUP (2026-10-28).
 *
 * Two follow-ups whose words are short, and so are often routed elsewhere
 * (the paid check, 2026-10-28: "@Match Time 2" and "@Match Time added the
 * venue location" came back `question`). They are read here, BEFORE the
 * router, by the shared admin extractor, the way an answer to "who shall I
 * ask for players?" is (`ask-source-group.ts`):
 *
 *   a pick from MatchTime's list of places
 *        the list is logged with the words it was for (`venuePickAskRef`);
 *        the organiser's next message after it, or a reply quoting it, is
 *        read with the list as MatchTime's last post (`venueListAnswered`).
 *        A `set_venue` with a number is that place of THE SAME WORDS, read
 *        from the record.
 *   a "try again" right after an ask
 *        an organiser's TAGGED message within 15 minutes of the organisers'
 *        stored ask to the partner clubs or the pool (`refused-ask-retry.ts`).
 *        A `retry_ask` is that ask again; a `set_venue` (the pitch named
 *        right after a refusal for want of one) is that.
 *
 * Anything else the model reads is not a follow-up: the message carries on
 * through the router as it would have. Only an owner or admin of the club.
 * No model call at all unless one of the two is waiting. Never throws.
 * Logs carry ids only.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { groupLogSince, recordGroupOrganiserLine, type HqLogRow } from "./admin-group-log";
import type { QuotedMessage } from "./admin-group-confirm-rules";
import { namedSources, type RecruitSource } from "./ask-source-rules";
import { extractForRouteTraced } from "./pipeline/trace";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import type { QuotedGroupMessage } from "./reply-context";
import { RETRY_FOLLOWUP_MS, latestAskFromRecords, retryFactsOf, type LatestAskForRetry } from "./refused-ask-retry";
import { parseVenuePickRef, venueListAnswered } from "./venue-from-words-rules";

const DAY_MS = 24 * 3600_000;
export { RETRY_FOLLOWUP_MS };

export type GroupFollowup =
  | { kind: "venue"; words: string | null; choice: number | null }
  | { kind: "retry"; sources: RecruitSource[]; clubRef: string | null };

export interface GroupFollowupCandidate {
  id: string;
  body: string;
  authorName: string | null;
  senderUserId: string | null;
  quoted: QuotedMessage | null;
  reply?: QuotedGroupMessage | null;
  /** The explicit tag on MatchTime. A "try again" needs it. */
  tagged: boolean;
}

export interface GroupFollowupDeps {
  log: (orgId: string, since: Date) => Promise<HqLogRow[]>;
  organisers: (orgId: string, userIds: string[]) => Promise<Set<string>>;
  latestAsk: LatestAskForRetry;
  recordLine: (id: string, a: { orgId: string; senderUserId: string; text: string; now: Date }) => Promise<void>;
  model?: PipelineModel;
}

const defaultDeps: GroupFollowupDeps = {
  log: groupLogSince,
  organisers: async (orgId, userIds) =>
    new Set(
      (
        (await db.membership.findMany({
          where: { orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, userId: { in: userIds }, ...ORDINARY_MEMBER_WHERE },
          select: { userId: true },
        })) ?? []
      ).map((r) => r.userId),
    ),
  latestAsk: latestAskFromRecords,
  recordLine: (id, a) => recordGroupOrganiserLine({ ...a, waMessageId: id }),
};

export async function groupAdminFollowups(args: {
  orgId: string;
  messages: GroupFollowupCandidate[];
  now: Date;
  deps?: GroupFollowupDeps;
}): Promise<Map<string, GroupFollowup>> {
  const out = new Map<string, GroupFollowup>();
  const { orgId, now } = args;
  const deps = args.deps ?? defaultDeps;
  try {
    const withSender = args.messages.filter((m) => m.senderUserId);
    if (withSender.length === 0) return out;
    const log = await deps.log(orgId, new Date(now.getTime() - DAY_MS));
    const listWaiting = log.some((r) => r.fromMatchTime && parseVenuePickRef(r.askRef));
    const stored = await deps.latestAsk({ orgId, where: "group", now });
    const again = stored && now.getTime() - stored.at.getTime() <= RETRY_FOLLOWUP_MS ? retryFactsOf(stored, now) : null;
    if (!listWaiting && !again) return out;
    const organisers = await deps.organisers(orgId, withSender.map((m) => m.senderUserId!));
    for (const m of withSender) {
      if (!organisers.has(m.senderUserId!)) continue;
      const list = listWaiting ? venueListAnswered({ quoted: m.quoted, log, now }) : null;
      const retryWindow = !!again && m.tagged;
      if (!list && !retryWindow) continue;
      if (list) {
        // In the place of an answer: logged, so a later organiser message is
        // not the next one after the list (positional, as for the source question).
        await deps.recordLine(m.id, { orgId, senderUserId: m.senderUserId!, text: m.body, now });
        log.push({ waMessageId: `group:${m.id}`, fromMatchTime: false, senderUserId: m.senderUserId, text: m.body, askRef: null, createdAt: now });
      }
      const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
      const extracted = await extractForRouteTraced("admin_ops", model, "admin_ops", {
        id: m.id,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history: [],
        lastBotPost: list?.text ?? null,
        ...(m.reply ? { reply: m.reply } : {}),
        now,
      }).catch(() => null);
      const facts = extracted?.facts.kind === "admin" ? extracted.facts : null;
      if (facts?.action === "set_venue") {
        const words = list ? parseVenuePickRef(list.askRef) : null;
        // A number picks from THE list's words; a name is its own words.
        const choice = list && facts.venueChoice ? facts.venueChoice : null;
        out.set(m.id, { kind: "venue", words: choice ? words : (facts.venueName ?? words), choice });
      } else if (facts?.action === "retry_ask" && retryWindow && again) {
        const sources = namedSources(again) ?? [];
        if (sources.length > 0) out.set(m.id, { kind: "retry", sources, clubRef: again.clubRef ?? null });
      }
      console.log(`[group-followup] ${m.id}: ${list ? "after MatchTime's list of places" : "after the organisers' ask"}: ${out.get(m.id)?.kind ?? `not a follow-up (${facts?.action ?? "not read"})`}`);
    }
  } catch (err) {
    console.error(`[group-followup] ${orgId}: not read:`, err instanceof Error ? err.message : "failed");
  }
  return out;
}
