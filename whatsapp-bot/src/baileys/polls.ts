/**
 * Poll votes under Baileys. Plan §2.12, Phase 4.
 *
 * ── What the plan assumed, and what rc14 actually does ──────────────
 * The plan expected votes on `messages.update` as `pollUpdates`, already
 * decrypted by Baileys through the `getMessage` option. In 7.0.0-rc14 that
 * whole branch of `lib/Utils/process-message.js` is COMMENTED OUT ("TODO:
 * Remove entirely"). Nothing emits `pollUpdates`. A vote reaches us as an
 * ordinary `messages.upsert` carrying an encrypted `pollUpdateMessage`,
 * and decrypting it is ours to do. So the driver never listens for
 * `messages.update`: if a later Baileys revives that path, listening to
 * both would count every vote twice.
 *
 * ── The decryption ──────────────────────────────────────────────────
 * Baileys' own `decryptPollVote` does the cryptography (HMAC-derived key,
 * AES-256-GCM, `${pollId}\0${voter}` as associated data). It needs four
 * things: the poll's `messageSecret` (only in the poll WE sent, hence the
 * archive), the poll id, and two JIDs: the poll creator's and the voter's,
 * written exactly as the VOTER's phone wrote them when it encrypted.
 *
 * Which addressing those two JIDs use is the one thing nobody can tell us
 * from reading code. Baileys' live event-response path (the same scheme)
 * says "all jids need to be PN", but a LID-addressed group may sign with
 * LIDs. So we try each candidate pair, phone forms first. That is SAFE,
 * not a guess: GCM authenticates, so a wrong pair fails the tag and throws,
 * and only the pair the voter really used can produce a plaintext. At most
 * four attempts per vote. Which pair worked is logged, so the Phase 5
 * shadow run answers the question for good.
 *
 * ── What goes up ────────────────────────────────────────────────────
 * The whatsapp-web.js `vote_update` shape `index.ts` reads:
 *
 *   parentMessage.id._serialized  the poll's id EXACTLY as the scheduler
 *                                 stored it: our own group post, with our
 *                                 id as participant via the same
 *                                 `ownJidFor` the send path used. MatchTime
 *                                 posts polls in groups only; a DM poll's
 *                                 parent keeps the chat as addressed;
 *   voter                         `447...@c.us` when a phone is known, the
 *                                 legacy LID otherwise (never LID digits
 *                                 passed off as a phone);
 *   selectedOptions               `{ name, localId }`, matched by SHA-256
 *                                 of each option name, as WhatsApp hashes
 *                                 them. An empty list is an un-vote.
 */
import {
  decryptPollVote,
  normalizeMessageContent,
  proto,
  sha256,
  type WAMessage,
} from "baileys";
import type { InboundPollVote } from "../driver.js";
import { legacyJid, serializeKey } from "./key.js";
import { bareUser, isGroupJid, resolveInboundSender, toUserJid } from "./jid.js";

export interface PollVoteDeps {
  /** The poll we sent with this message id, from memory or the archive. */
  pollMessage(id: string): proto.IMessage | undefined;
  /** Our own ids as `sock.user` has them (a device suffix is fine). */
  self(): { pn: string | null; lid: string | null };
  /** Which of our ids a post of ours in this group carries. Shared with sends. */
  ownJidFor(chatJid: string): string | null | undefined;
  /** Phone digits for a full LID JID, from local state only. May throw. */
  phoneForLid(lidJid: string): Promise<string | null>;
}

export type MappedPollVote =
  | { kind: "not-a-vote" }
  | { kind: "own" }
  | { kind: "forward"; payload: InboundPollVote; via: { creator: string; voter: string } }
  | { kind: "undecryptable"; pollId: string; reason: string };

/** The encrypted vote on this message, or null when it is not one. */
export function pollUpdateOf(m: WAMessage | null | undefined): proto.Message.IPollUpdateMessage | null {
  try {
    return normalizeMessageContent(m?.message)?.pollUpdateMessage ?? null;
  } catch {
    return null;
  }
}

/** A poll's option names, in order, whichever creation version it is. */
export function pollOptionNames(message: proto.IMessage | null | undefined): string[] {
  const c =
    message?.pollCreationMessage ?? message?.pollCreationMessageV2 ?? message?.pollCreationMessageV3 ?? null;
  return (c?.options ?? []).map((o) => o?.optionName ?? "");
}

/** A poll message as base64, for the archive. */
export function encodePollMessage(message: proto.IMessage): string {
  return Buffer.from(proto.Message.encode(message).finish()).toString("base64");
}

/** Back from the archive; null unless it is a poll with a secret. */
export function decodePollMessage(b64: string | null | undefined): proto.IMessage | null {
  if (!b64) return null;
  try {
    const m = proto.Message.decode(Buffer.from(b64, "base64"));
    const secret = m.messageContextInfo?.messageSecret;
    if (!secret || secret.length === 0 || pollOptionNames(m).length === 0) return null;
    return m;
  } catch {
    return null;
  }
}

function unique(list: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const j of list) {
    const b = bareUser(j);
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
}

export async function mapPollVote(m: WAMessage, deps: PollVoteDeps): Promise<MappedPollVote> {
  const update = pollUpdateOf(m);
  if (!update) return { kind: "not-a-vote" };
  const key = m.key ?? {};
  if (key.fromMe) return { kind: "own" };

  const pollKey = update.pollCreationMessageKey ?? {};
  const pollId = pollKey.id ?? "";
  const chat = pollKey.remoteJid || key.remoteJid || "";
  if (!pollId || !chat) return { kind: "undecryptable", pollId, reason: "the vote names no poll" };

  const poll = deps.pollMessage(pollId);
  if (!poll) {
    return {
      kind: "undecryptable",
      pollId,
      reason:
        "we hold no poll with this id: it was sent before the cutover (by whatsapp-web.js), " +
        "fell out of the archive, or was never ours",
    };
  }
  const secret = poll.messageContextInfo?.messageSecret;
  const enc = update.vote;
  if (!secret || !enc?.encPayload || !enc?.encIv) {
    return { kind: "undecryptable", pollId, reason: "the poll has no secret or the vote has no payload" };
  }

  const self = deps.self();
  const creators = unique([self.pn, self.lid]);
  const group = isGroupJid(key.remoteJid);
  const voters = group
    ? unique([key.participantAlt, key.participant])
    : unique([key.remoteJidAlt, key.remoteJid]);

  let selected: Uint8Array[] | null = null;
  let via: { creator: string; voter: string } | null = null;
  for (const voter of voters) {
    for (const creator of creators) {
      try {
        const out = decryptPollVote(enc, { pollEncKey: secret, pollCreatorJid: creator, pollMsgId: pollId, voterJid: voter });
        selected = (out.selectedOptions ?? []) as Uint8Array[];
        via = { creator, voter };
        break;
      } catch {
        /* the GCM tag says this is not the pair the voter used */
      }
    }
    if (via) break;
  }
  if (!selected || !via) {
    return {
      kind: "undecryptable",
      pollId,
      reason:
        `no identity pair decrypted it (creators ${creators.join(", ") || "none"}; ` +
        `voters ${voters.join(", ") || "none"})`,
    };
  }

  const names = pollOptionNames(poll);
  const byHash = new Map(names.map((name, i) => [sha256(Buffer.from(name)).toString("hex"), { name, localId: i }]));
  const selectedOptions: Array<{ name: string; localId: number }> = [];
  for (const h of selected) {
    const hit = byHash.get(Buffer.from(h).toString("hex"));
    if (hit) selectedOptions.push({ ...hit });
  }

  // The poll is ours (we held its secret), so its stored id carries OUR id
  // as participant in a group, chosen the way the send path chose it.
  const parentKey = group
    ? { remoteJid: chat, fromMe: true, id: pollId, participant: deps.ownJidFor(chat) ?? undefined }
    : { remoteJid: chat, fromMe: true, id: pollId };
  const parentId = serializeKey(parentKey);
  if (!parentId) {
    return { kind: "undecryptable", pollId, reason: "decrypted, but the poll's key could not be serialised" };
  }

  return {
    kind: "forward",
    payload: {
      parentMessage: { id: { _serialized: parentId } },
      voter: await voterId(key, deps),
      selectedOptions,
    },
    via,
  };
}

async function voterId(key: WAMessage["key"], deps: PollVoteDeps): Promise<string> {
  try {
    const who = await resolveInboundSender(key ?? {}, async (lid) => {
      const phone = await deps.phoneForLid(lid);
      return phone ? toUserJid(phone) : null;
    });
    if (who.phone) return `${who.phone}@c.us`;
  } catch {
    /* fall through to the id as addressed */
  }
  const raw = isGroupJid(key?.remoteJid) ? key?.participant : key?.remoteJid;
  return legacyJid(raw) ?? "";
}

/** For log lines. */
export function describeVia(via: { creator: string; voter: string }): string {
  return `creator=${via.creator} voter=${via.voter}`;
}
