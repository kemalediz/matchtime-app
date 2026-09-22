/**
 * A Baileys `messages.reaction` event, as the payload `index.ts` reads.
 *
 * ── The one question ────────────────────────────────────────────────
 * The server joins a reaction to what it sent by EXACT string match on
 * `waMessageId` (`src/app/api/whatsapp/reaction/route.ts`), against the id
 * the scheduler stored when the message went out. So the id handed up must
 * equal that string byte for byte, and every rule below exists to make it.
 *
 * ── What Baileys gives us ───────────────────────────────────────────
 * `process-message.js` emits `{ key, reaction }` where `key` is the TARGET
 * message's key, already turned round to our perspective (`fromMe` true
 * for our own message), and `reaction.key` is the reaction message's own
 * envelope, `remoteJidAlt` / `participantAlt` included. Two details in
 * `normaliseKey` decide everything:
 *
 *   - `msgKey.remoteJid = message.key.remoteJid`: the target's chat is
 *     written as the CHAT's id, which for a DM is now often the other
 *     person's LID;
 *   - `msgKey.participant = msgKey.participant || message.key.participant`:
 *     in a group, the target's author is whatever the REACTOR's client
 *     wrote, which for our own post is our id in the reactor's addressing,
 *     and if the client omitted it, it becomes the reactor.
 *
 * ── The rules ───────────────────────────────────────────────────────
 * DM target: the bot sent it to the PHONE (`sendDirectText`), so the stored
 * id is `true_<phone>@c.us_<id>`. A LID chat is converted to that phone,
 * from the envelope's alt first, then from the harvested / local mapping,
 * BEFORE `serializeKey` runs. When neither knows the phone the target is
 * UNRESOLVED: the payload goes up with no `msgId`, which is precisely what
 * `index.ts` records as `reaction-forwarding` degraded (off the Pi, on the
 * next heartbeat) with its CRITICAL line. The LID-form id is never handed
 * up: it cannot match anything, so forwarding it would be the silent miss.
 *
 * Group target, our own post: the participant is overwritten with
 * `ownJidFor(chat)`, the same function the send path used to complete the
 * key it stored (`completeOwnKey`), so the two sides cannot disagree
 * whatever the reactor's client wrote.
 *
 * Group target, somebody else's message: left as addressed. The inbound
 * path stored `serializeKey` of the same key, LID and all.
 *
 * The reactor (`senderId`) goes up as a phone JID when it can be resolved,
 * and as the legacy LID otherwise, which `index.ts` already forwards with
 * an empty phone and the reactor's name, exactly as it did for a
 * whatsapp-web.js privacy-mode reactor.
 *
 * The echo of the bot's OWN reaction is not handed up: Baileys emits our
 * sends back, and every ✅ the flush placed would otherwise be POSTed to
 * the server as though a player had reacted.
 *
 * Pure apart from the injected lookup. Never throws.
 */
import { legacyJid, serializeKey, type KeyLike } from "./key.js";
import {
  isGroupJid,
  isLidJid,
  lidLookupJid,
  phoneFromJid,
  resolveInboundSender,
  toUserJid,
  type InboundKeyLike,
} from "./jid.js";

export interface ReactionEvent {
  /** The reacted-to message's key, from our perspective. */
  key?: (KeyLike & { remoteJidAlt?: string | null; participantAlt?: string | null }) | null;
  reaction?: {
    text?: string | null;
    /** The reaction message's own envelope. */
    key?: InboundKeyLike | null;
    senderTimestampMs?: unknown;
  } | null;
}

export interface ReactionDeps {
  /** Which of our ids a post of ours in this group carries. Shared with the send path. */
  ownJidFor(chatJid: string): string | null | undefined;
  /** Phone digits for a LID (full JID), from harvested and local state only. May throw. */
  phoneForLid(lidJid: string): Promise<string | null>;
}

/** What `index.ts` reads, in whatsapp-web.js's names. */
export interface HandedUpReaction {
  msgId?: { _serialized: string };
  senderId: string;
  reaction: string;
  /** Seconds, when WhatsApp said. */
  timestamp?: number;
}

export type MappedReaction =
  | { kind: "own" }
  | {
      kind: "forward";
      payload: HandedUpReaction;
      /** Set when a real reaction's target could not be turned into the stored id. */
      unresolved?: { reason: string; lid?: string; wouldHaveBeen?: string };
    };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function seconds(ms: unknown): number | undefined {
  const n =
    typeof ms === "number"
      ? ms
      : ms && typeof (ms as { toNumber?: unknown }).toNumber === "function"
        ? (ms as { toNumber: () => number }).toNumber()
        : Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : undefined;
}

export async function mapReaction(evt: ReactionEvent, deps: ReactionDeps): Promise<MappedReaction> {
  const target = evt?.key ?? {};
  const envelope = evt?.reaction?.key ?? {};
  const emoji = typeof evt?.reaction?.text === "string" ? evt.reaction.text : "";

  if (envelope.fromMe === true) return { kind: "own" };

  const senderId = await reactorId(envelope, deps);
  const payload: HandedUpReaction = { senderId, reaction: emoji };
  const ts = seconds(evt?.reaction?.senderTimestampMs);
  if (ts) payload.timestamp = ts;

  const resolved = await resolveTarget(target, envelope, deps);
  if ("unresolved" in resolved) {
    // A removed reaction (empty emoji) is ignored by index.ts before it
    // looks at the id, so it is not lost data and is not counted as such.
    return emoji ? { kind: "forward", payload, unresolved: resolved.unresolved } : { kind: "forward", payload };
  }
  const id = serializeKey(resolved.key);
  if (id) {
    payload.msgId = { _serialized: id };
    return { kind: "forward", payload };
  }
  return emoji
    ? { kind: "forward", payload, unresolved: { reason: "the target key could not be serialised" } }
    : { kind: "forward", payload };
}

async function resolveTarget(
  target: NonNullable<ReactionEvent["key"]>,
  envelope: InboundKeyLike,
  deps: ReactionDeps,
): Promise<{ key: KeyLike } | { unresolved: { reason: string; lid?: string; wouldHaveBeen?: string } }> {
  const chat = target.remoteJid;
  if (!chat || !target.id) return { unresolved: { reason: "the reaction names no target message" } };

  if (isGroupJid(chat)) {
    if (target.fromMe !== true) return { key: target };
    let own: string | null | undefined;
    try {
      own = deps.ownJidFor(chat);
    } catch {
      own = undefined;
    }
    return { key: { ...target, participant: own || target.participant } };
  }

  // A DM. Ids for DMs never carried a participant.
  const dm: KeyLike = { remoteJid: chat, fromMe: target.fromMe, id: target.id };
  if (!isLidJid(chat)) return { key: dm };

  const lidJid = lidLookupJid(chat) ?? chat;
  let phone = phoneFromJid(envelope.remoteJidAlt) ?? phoneFromJid(target.remoteJidAlt);
  if (!phone) {
    try {
      phone = phoneFromJid(toUserJid(String((await deps.phoneForLid(lidJid)) ?? "")));
    } catch (err) {
      return {
        unresolved: {
          reason: `the LID mapping lookup failed: ${errorText(err)}`,
          lid: legacyJid(chat) ?? chat,
          wouldHaveBeen: serializeKey(dm) ?? undefined,
        },
      };
    }
  }
  if (!phone) {
    return {
      unresolved: {
        reason:
          "the DM arrived under a LID and there is no phone number for it on the envelope, " +
          "in the harvested contacts or in Baileys' local mapping store",
        lid: legacyJid(chat) ?? chat,
        wouldHaveBeen: serializeKey(dm) ?? undefined,
      },
    };
  }
  return { key: { ...dm, remoteJid: toUserJid(phone) } };
}

/** The reactor as a phone JID when known, else the legacy JID as addressed. */
async function reactorId(envelope: InboundKeyLike, deps: ReactionDeps): Promise<string> {
  const who = await resolveInboundSender(envelope, async (lid) => {
    const phone = await deps.phoneForLid(lid);
    return phone ? toUserJid(phone) : null;
  });
  if (who.phone) return `${who.phone}@c.us`;
  const raw = isGroupJid(envelope.remoteJid) ? envelope.participant : envelope.remoteJid;
  return legacyJid(raw) ?? "";
}
