/**
 * "@MATCH TIME DM THESE PEOPLE": ONE DOOR FOR EVERY GROUP (2026-11-09).
 *
 * The players' group (`api/whatsapp/analyze/route.ts`) and HQ
 * (`admin-group-understand.ts`) both call this once the shared pipeline
 * has read an organiser's tagged message as recruit from the people tagged
 * (`playersFrom: ["named"]`) and the gates have passed (an owner or admin,
 * an explicit tag). It finds whose tags are meant from WhatsApp's mention
 * data (`named-invite-rules.ts` `pickNamedMentions`: the message itself, the
 * message it quotes, or the latest one above it that tagged people), DMs
 * the ones MatchTime knows the club's invite (`recruit.ts`
 * `inviteNamedPeople`), and returns the one reply, which also says whose
 * message was used. It never throws: a failure is a short reply saying
 * nobody was messaged (review #10). Logs carry ids and counts only.
 */
import { mentionsAbove, mentionsOfQuoted, storedTagsOf, type MentionSource } from "./group-mentions";
import { namedInviteReply, pickAbove, pickNamedMentions, taggedPeopleOf, type NamedSource } from "./named-invite-rules";
import { inviteNamedPeople } from "./recruit";
import type { Lang } from "./i18n/lang";

export interface NamedInviteRequest {
  orgId: string;
  /** The WhatsApp group the request was made in. */
  chatId: string;
  lang: Lang | string | null | undefined;
  message: {
    waMessageId: string;
    sentAt: Date;
    mentions?: unknown;
    mentionNames?: unknown;
    botMentioned?: unknown;
    /** Set when the request is a WhatsApp reply. */
    quotedMessageId?: string | null;
  };
  /** The messages that arrived ahead of the request in its own flush, in
   *  arrival order: "the people above" may be one of them (review #5). */
  batchBefore?: MentionSource[];
  requesterUserId: string | null;
}

export interface NamedInviteDone {
  /** "named-done", "named-full", "named-no-match", "named-nobody-tagged",
   *  "named-failed". */
  outcome: string;
  replyText: string;
  invited: number;
  from: NamedSource | null;
  matchId: string | null;
}

export async function dmNamedPeople(req: NamedInviteRequest): Promise<NamedInviteDone> {
  const { orgId, message } = req;
  const failed = (why: unknown): NamedInviteDone => {
    console.error(`[named-invite] ${message.waMessageId}: failed, nobody DM'd:`, why instanceof Error ? why.message : why);
    return { outcome: "named-failed", replyText: namedInviteReply({ kind: "failed" }, req.lang), invited: 0, from: null, matchId: null };
  };
  try {
    const own = taggedPeopleOf(message);
    const ownTagged = own.mentions.length > 0 || own.unidentified > 0;
    const quotedId = typeof message.quotedMessageId === "string" && message.quotedMessageId.trim() ? message.quotedMessageId.trim() : null;
    const quoted = !ownTagged && quotedId ? await mentionsOfQuoted(orgId, quotedId) : null;
    let above = null;
    if (!ownTagged && !quotedId) {
      const batch = (req.batchBefore ?? []).map((m) => storedTagsOf(m, message.sentAt)).filter((x): x is NonNullable<typeof x> => x !== null);
      const stored = await mentionsAbove({
        orgId,
        chatId: req.chatId,
        before: message.sentAt,
        excludeWaMessageIds: [message.waMessageId, ...(req.batchBefore ?? []).map((m) => m.waMessageId)],
      });
      above = pickAbove({ stored, batchBefore: batch, before: message.sentAt });
    }
    const picked = pickNamedMentions({ own, isReply: !!quotedId, quoted, above });
    if (!picked) {
      console.log(`[named-invite] ${message.waMessageId}: nobody tagged (${quotedId ? "reply" : "above"}); nobody DM'd`);
      return { outcome: "named-nobody-tagged", replyText: namedInviteReply({ kind: "nobody-tagged" }, req.lang), invited: 0, from: null, matchId: null };
    }
    const r = await inviteNamedPeople(orgId, picked.people, { requesterUserId: req.requesterUserId });
    const invited = r.kind === "done" ? r.plan.invite.length : 0;
    console.log(
      `[named-invite] ${message.waMessageId}: ${picked.people.mentions.length} tagged, ${picked.people.unidentified} unidentified (${picked.from}) -> ${r.kind}` +
        (r.kind === "done"
          ? `, DM'd ${invited} [${r.plan.invite.map((p) => p.userId).join(",")}], unknown ${r.plan.unknown.length + r.plan.unknownUnlabelled}, ` +
            `opted out ${r.plan.optedOut.length}, not here ${r.plan.notHere.length}, answered ${r.plan.answered.length}, ` +
            `already invited ${r.plan.alreadyInvited.length}, over cap ${r.plan.overCap.length}`
          : ""),
    );
    return {
      outcome: `named-${r.kind}`,
      replyText: namedInviteReply(r, req.lang, r.kind === "done" ? { from: picked.from, senderName: picked.senderName } : null),
      invited,
      from: picked.from,
      matchId: r.matchId ?? null,
    };
  } catch (err) {
    return failed(err);
  }
}
