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
 * `inviteNamedPeople`), and returns the one reply. Logs carry ids and
 * counts only.
 */
import { mentionsAbove, mentionsOfQuoted } from "./group-mentions";
import { namedInviteReply, pickNamedMentions, storedMentionsOf, type NamedSource } from "./named-invite-rules";
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
  requesterUserId: string | null;
}

export interface NamedInviteDone {
  /** "named-done", "named-full", "named-no-match", "named-nobody-tagged". */
  outcome: string;
  replyText: string;
  invited: number;
  from: NamedSource | null;
  matchId: string | null;
}

export async function dmNamedPeople(req: NamedInviteRequest): Promise<NamedInviteDone> {
  const { orgId, message } = req;
  const own = storedMentionsOf(message);
  const quotedId = typeof message.quotedMessageId === "string" && message.quotedMessageId.trim() ? message.quotedMessageId.trim() : null;
  const quoted = own.length === 0 && quotedId ? await mentionsOfQuoted(orgId, quotedId) : null;
  const above =
    own.length === 0 && !quotedId
      ? await mentionsAbove({ orgId, chatId: req.chatId, before: message.sentAt, excludeWaMessageId: message.waMessageId })
      : null;
  const picked = pickNamedMentions({ own, isReply: !!quotedId, quoted, above });
  if (!picked) {
    console.log(`[named-invite] ${message.waMessageId}: nobody tagged (${quotedId ? "reply" : "above"}); nobody DM'd`);
    return { outcome: "named-nobody-tagged", replyText: namedInviteReply({ kind: "nobody-tagged" }, req.lang), invited: 0, from: null, matchId: null };
  }
  const r = await inviteNamedPeople(orgId, picked.mentions, { requesterUserId: req.requesterUserId });
  const invited = r.kind === "done" ? r.plan.invite.length : 0;
  console.log(
    `[named-invite] ${message.waMessageId}: ${picked.mentions.length} tagged (${picked.from}) -> ${r.kind}` +
      (r.kind === "done"
        ? `, DM'd ${invited} [${r.plan.invite.map((p) => p.userId).join(",")}], unknown ${r.plan.unknown.length + r.plan.unknownUnlabelled}, ` +
          `opted out ${r.plan.optedOut.length}, answered ${r.plan.answered.length}, already invited ${r.plan.alreadyInvited.length}, over cap ${r.plan.overCap.length}`
        : ""),
  );
  return { outcome: `named-${r.kind}`, replyText: namedInviteReply(r, req.lang), invited, from: picked.from, matchId: r.matchId ?? null };
}
