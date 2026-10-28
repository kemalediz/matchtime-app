/**
 * "WHO SHALL I ASK FOR PLAYERS?" IN THE PLAYERS' GROUP (2026-10-28).
 *
 * Friday MT Community has no admin group. Kemal tagged MatchTime in the
 * players' group: "find me players feom partner clubs and player pool", and
 * heard "No new players to ask for Football 9-a-side right now." The words
 * named two places and the prompt had room for one, so it said "unsaid";
 * and only HQ asked the organiser which place he meant.
 *
 * Now the players' group asks the same question as HQ, from the same rules
 * (`ask-source-rules.ts`), logged the same way (`ask-source.ts`,
 * `admin-group-log.ts` `recordGroupQuestion`), and its answer is found and
 * read the same way. This file is the reading:
 *
 *   in the place of an answer   the safe-YES rule's two positional tests
 *                               (`sourceQuestionAnswered`) on the group's
 *                               log: a reply quoting the question, or the
 *                               next message from an ORGANISER after it
 *                               within 15 minutes. The log holds only
 *                               MatchTime's question and the organisers'
 *                               messages read after it, so the players'
 *                               own chat in between never closes it.
 *   read by the model           the shared admin extractor, with the
 *                               question as MatchTime's last post. "the
 *                               pool", "both", "her yerden": the places it
 *                               names. Anything else is not an answer, and
 *                               the message carries on as it would have.
 *
 * Only an owner or admin of the club, as for every admin feature in the
 * group. Calls the model, so no pool module is imported here
 * (`pool/__tests__/source-guard.test.ts`). Never throws: a failed read is
 * "not an answer". Logs carry ids only.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { groupLogSince, recordGroupOrganiserLine, type HqLogRow } from "./admin-group-log";
import { parseAskSourceRef, sourceQuestionAnswered, sourcesFromAnswer, type RecruitSource } from "./ask-source-rules";
import type { QuotedMessage } from "./admin-group-confirm-rules";
import { extractForRouteTraced } from "./pipeline/trace";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import type { QuotedGroupMessage } from "./reply-context";

const DAY_MS = 24 * 3600_000;

export interface GroupAnswerCandidate {
  id: string;
  body: string;
  authorName: string | null;
  senderUserId: string | null;
  /** The Pi's facts about the message it quotes, when it is a reply. */
  quoted: QuotedMessage | null;
  /** The quote as the batch resolved it, shown to the extractor. */
  reply?: QuotedGroupMessage | null;
  tagged: boolean;
}

export interface GroupSourceAnswer {
  sources: RecruitSource[];
  clubRef: string | null;
}

/**
 * The messages of this batch that answer MatchTime's "who shall I ask for
 * players?" in the players' group, with the places each picks. Every
 * organiser's message read in the place of an answer is logged, so the
 * next one is not "the next message" any more.
 */
export async function groupSourceAnswers(args: {
  orgId: string;
  messages: GroupAnswerCandidate[];
  now: Date;
  /** Injected in tests only. */
  model?: PipelineModel;
}): Promise<Map<string, GroupSourceAnswer>> {
  const out = new Map<string, GroupSourceAnswer>();
  const { orgId, now } = args;
  try {
    const withSender = args.messages.filter((m) => m.senderUserId);
    if (withSender.length === 0) return out;
    const log: HqLogRow[] = await groupLogSince(orgId, new Date(now.getTime() - DAY_MS));
    if (!log.some((r) => r.fromMatchTime && parseAskSourceRef(r.askRef))) return out;
    const organisers = new Set(
      (
        (await db.membership.findMany({
          where: { orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, userId: { in: withSender.map((m) => m.senderUserId!) }, ...ORDINARY_MEMBER_WHERE },
          select: { userId: true },
        })) ?? []
      ).map((r) => r.userId),
    );
    for (const m of withSender) {
      if (!organisers.has(m.senderUserId!)) continue;
      const options = sourceQuestionAnswered({ quoted: m.quoted, log, now });
      if (!options) continue;
      const question = [...log].reverse().find((r) => r.fromMatchTime && parseAskSourceRef(r.askRef)) ?? null;
      // In the place of an answer: logged, so a later organiser message is
      // not the next one after the question (positional, like HQ's).
      await recordGroupOrganiserLine({ orgId, waMessageId: m.id, senderUserId: m.senderUserId!, text: m.body, now });
      log.push({ waMessageId: `group:${m.id}`, fromMatchTime: false, senderUserId: m.senderUserId, text: m.body, askRef: null, createdAt: now });
      const model = args.model ?? extractorStubFromEnv() ?? anthropicModel();
      const extracted = await extractForRouteTraced("admin_ops", model, "admin_ops", {
        id: m.id,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history: [],
        lastBotPost: question?.text ?? null,
        ...(m.reply ? { reply: m.reply } : {}),
        now,
      }).catch(() => null);
      const facts = extracted?.facts.kind === "admin" ? extracted.facts : null;
      const sources = sourcesFromAnswer(facts);
      console.log(`[ask-source-group] ${m.id}: in the place of an answer to the source question: ${sources?.join("+") ?? "not an answer"}`);
      if (sources) out.set(m.id, { sources, clubRef: facts?.clubRef?.trim() || null });
    }
  } catch (err) {
    console.error(`[ask-source-group] ${orgId}: answers not read:`, err instanceof Error ? err.message : "failed");
  }
  return out;
}
