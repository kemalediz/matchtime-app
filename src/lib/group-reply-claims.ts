/**
 * MATCHTIME'S OWN IN-GROUP REPLIES ARE RECORDED LIKE ITS OTHER POSTS
 * (quoted-reply context, review of #341, finding 3).
 *
 * The analyze route's `reply` and HQ's `replyText` are sent by the Pi
 * straight from the response, not through /due-posts, so they had no
 * SentNotification row: a WhatsApp reply quoting one ("no, it was 7-5",
 * under MatchTime's "That match is already recorded") could not be named
 * by its id, and carried no match. Each such reply is now CLAIMED here,
 * with its words and its match, under a key of this club
 * (`groupReplyKey`, `hqReplyKey`), and the Pi acks it with the sent id the
 * way it acks every scheduled post (/api/whatsapp/ack stamps
 * `waStanzaId`). A failed claim never stops the reply.
 */
import { db } from "./db";
import { CLAIM_TEXT_MAX } from "./dispatch-claim";
import { GROUP_REPLY_KIND, HQ_REPLY_KIND, groupReplyKey, hqReplyKey } from "./reply-context";

export interface ReplyToClaim {
  /** The inbound message the reply answers. */
  inboundId: string;
  text: string;
  /** The match the reply is about, when the owner that wrote it knows. */
  matchId: string | null;
}

/** Claims each reply; returns the key to hand the Pi for its ack, by inbound id. */
export async function claimGroupReplies(args: { orgId: string; door: "group" | "hq"; replies: ReplyToClaim[] }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of args.replies) {
    if (!r.text.trim()) continue;
    const key = args.door === "group" ? groupReplyKey(args.orgId, r.inboundId) : hqReplyKey(args.orgId, r.inboundId);
    try {
      await db.sentNotification.create({
        data: {
          key,
          kind: args.door === "group" ? GROUP_REPLY_KIND : HQ_REPLY_KIND,
          ...(r.matchId ? { matchId: r.matchId } : {}),
          text: r.text.slice(0, CLAIM_TEXT_MAX),
        },
      });
      out.set(r.inboundId, key);
    } catch (err) {
      // Already claimed (a re-sent batch): the ack still stamps that row.
      if ((err as { code?: string }).code === "P2002") out.set(r.inboundId, key);
      else console.error(`[reply-claim] ${key}: not recorded:`, err instanceof Error ? err.message : "failed");
    }
  }
  return out;
}
