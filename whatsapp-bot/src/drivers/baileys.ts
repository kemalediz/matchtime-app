/**
 * The Baileys driver: the OUTBOUND half, plus the key serialiser it rests on.
 *
 * ── Where this sits ─────────────────────────────────────────────────
 * Phase 3 of `MDs/baileys-migration-plan-2026-09-21.md`. It implements the
 * `WaDriver` interface from `driver.ts` for the six sends the bot makes
 * (`sendText`, `sendTextWithMentions`, `sendDirectText`, `sendPoll`,
 * `sendReaction`, `replyTo`) plus `close`, and the bounded store that
 * Baileys' `getMessage` socket option reads.
 *
 * It is NOT reachable. `driver-select.ts` still refuses `WA_DRIVER=baileys`,
 * because a bot on this driver could send but not hear: lifecycle, inbound
 * and groups are not built. Unset, `WA_DRIVER` runs whatsapp-web.js exactly
 * as before. Nothing here changes what the Pi runs.
 *
 * ── The socket is injected, not owned ───────────────────────────────
 * `getSocket()` returns the live socket or null. Building and reconnecting
 * the socket is Phase 1's `baileys/main.ts` (generation counter, reconnect
 * policy, pairing), and moving that in belongs with the inbound wiring.
 * Injecting it is also what lets every line of this file run in a test
 * against a fake, with no network: no test may open a socket.
 *
 * ── Every send goes through one door ────────────────────────────────
 * `send()` is the only caller of `sock.sendMessage`. It refuses when
 * there is no socket (throwing, so the scheduler sees a failed send rather
 * than acking one that never went out), and it records what was sent for
 * `getMessage`. `baileys.source.test.ts` counts the call sites.
 *
 * Every text is built by `textContent` or `mentionContent`, which set
 * `linkPreview: null` (§2.6). A bare text object would make the Pi fetch
 * the magic links we send.
 *
 * ── Ids come back in the format the database already holds ──────────
 * The scheduler reads a sent message's id with `send-result.ts`, which
 * wants `result.id._serialized`. A Baileys `WAMessage` has a `key`
 * instead, so each send resolves to a small wrapper carrying the
 * whatsapp-web.js-format id from `serializeKey` (§2.5), after
 * `completeOwnKey` has put OUR JID on our own group posts the way
 * whatsapp-web.js did. Without that step every bench-offer reaction after
 * cutover would miss its offer. `outbound.ts` has the full reasoning.
 *
 * ── What this driver refuses, and why ───────────────────────────────
 *   sendTextViaChat  REFUSED, deliberately, not collapsed into sendText.
 *                    The group reply calls it only after `sendText` has
 *                    THROWN. Under whatsapp-web.js that fallback was a
 *                    different code path, and that difference was its
 *                    whole value (on 2026-08-28 one path threw while the
 *                    other worked). Under Baileys there is one path, so a
 *                    second attempt can only fail the same way or, when the
 *                    first send got out before it threw (a timeout, a
 *                    socket closing after the write), post the reply TWICE.
 *                    At-most-once is a product decision here, and the
 *                    2026-07-19 flood was 30+ copies of one post. The
 *                    refusal lands in the caller's catch, which already
 *                    logs "[smart] reply failed".
 *   listDmChats      No Baileys equivalent: there is no chat store (plan
 *                    §1.4 item 43, §2.14). Fails by name so
 *                    `BOT_RECOVER_DM_REPLIES=1` fails visibly instead of
 *                    "recovering" zero chats.
 *   everything else  Not built yet, and each says which phase owns it.
 *                    Registration members throw synchronously and async
 *                    members reject, which is how each one's callers
 *                    already expect a failure to look. None of them
 *                    returns an empty value: several call sites read an
 *                    empty roster or a missing id as "healthy", and
 *                    `driver.ts` records which throws are the bot's only
 *                    off-Pi health signal.
 *
 * ── Two rules, never broken ─────────────────────────────────────────
 * `close()` calls `end(undefined)` and never `logout()`, which unlinks the
 * device and costs a re-pair (§2.10). And nothing here ever asks WhatsApp
 * about a number (§2.2): a hundred such lookups got every linked device on
 * HomeTenant's account unlinked on 2026-09-17.
 */
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAMessageKey,
  proto,
} from "baileys";
import type { WaDriver } from "../driver.js";
import type { ReactionOutcome } from "../react-with-id.js";
import { parseKey, serializeKey } from "../baileys/key.js";
import {
  completeOwnKey,
  mentionContent,
  pollContent,
  reactionContent,
  textContent,
} from "../baileys/outbound.js";
import { createSentMessageStore, type SentMessageStore } from "../baileys/sent-store.js";
import { phoneFromJid, toUserJid } from "../baileys/jid.js";

/** The part of Baileys' `WASocket` this half of the driver touches. */
export interface BaileysSocketLike {
  user?: { id?: string | null; lid?: string | null } | null;
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<WAMessage | undefined>;
  end(error: Error | undefined): void;
}

export interface BaileysDriverDeps {
  /** The live socket, or null while there is none. */
  getSocket(): BaileysSocketLike | null | undefined;
  /**
   * How a group addresses its members, when known. Decides which of our
   * ids goes into our own group posts' stored ids: the LID in a
   * LID-addressed group, the phone JID otherwise, as whatsapp-web.js did.
   *
   * Phase 4 supplies this from its `cachedGroupMetadata`
   * (`GroupMetadata.addressingMode`). Until then it is absent and the
   * phone form is used, which is right for phone-addressed groups and
   * WRONG for LID-addressed ones: in those, a reaction to one of our posts
   * would carry our LID and miss the stored id. Do not make this driver
   * selectable without it.
   */
  groupAddressingMode?(groupJid: string): "lid" | "pn" | undefined;
  /** Injected for tests; defaults to a fresh bounded store. */
  store?: SentMessageStore<proto.IMessage>;
}

/**
 * What every send resolves to: something `send-result.ts` can read an id
 * out of (`id._serialized`), plus the real key and message for anyone who
 * needs more. `id` is absent only when the key could not be serialised.
 */
export interface BaileysSendResult {
  id?: { _serialized: string };
  key: WAMessageKey;
  message: WAMessage;
}

export interface BaileysDriver extends WaDriver {
  /**
   * For `makeWASocket({ getMessage })`: the message we sent with this key,
   * so Baileys can re-encrypt it when a recipient asks for a retry, and so
   * Phase 4 can decrypt votes on a poll.
   */
  getMessage(key: Pick<WAMessageKey, "id"> | null | undefined): Promise<proto.IMessage | undefined>;
}

/** Why a member will not do its job under Baileys. */
export type UnsupportedKind = "not-built-yet" | "no-baileys-equivalent";

/**
 * A driver member refusing, by name.
 *
 * Its own class so a log line or a test can tell "Baileys cannot do this"
 * apart from "WhatsApp said no".
 */
export class BaileysDriverUnsupportedError extends Error {
  override readonly name = "BaileysDriverUnsupportedError";
  constructor(
    readonly member: string,
    readonly kind: UnsupportedKind,
    detail: string,
  ) {
    super(
      `[baileys driver] ${member}: ` +
        `${kind === "not-built-yet" ? "not built yet" : "no Baileys equivalent"}. ${detail}`,
    );
  }
}

/** The socket is down: nothing was sent. */
class NotConnectedError extends Error {
  override readonly name = "NotConnectedError";
  constructor() {
    super("[baileys driver] WhatsApp is not connected, so nothing was sent");
  }
}

const PHASE_4 =
  "Groups, participants, join and leave, and polls are Phase 4 of " +
  "MDs/baileys-migration-plan-2026-09-21.md.";
const INBOUND =
  "The socket lifecycle and the inbound path are not in the driver yet; Phase 1's observer " +
  "(src/baileys/main.ts, inbound.ts) has the pieces. They must land before driver-select.ts " +
  "accepts WA_DRIVER=baileys.";
const HISTORY =
  "Whether the restart replay is needed at all under Baileys is the plan's open measurement " +
  "(§2.15, Phase 5); build it after that, on fetchMessageHistory if at all.";

function notYet(member: keyof WaDriver, detail: string): never {
  throw new BaileysDriverUnsupportedError(member, "not-built-yet", detail);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A whatsapp-web.js person JID (`@c.us`) in Baileys' spelling; anything else as it is. */
function wireChatJid(chatId: string): string {
  return chatId.endsWith("@c.us") ? `${chatId.slice(0, -"@c.us".length)}@s.whatsapp.net` : chatId;
}

export function makeBaileysDriver(deps: BaileysDriverDeps): BaileysDriver {
  const store = deps.store ?? createSentMessageStore<proto.IMessage>();

  /** Which of our ids a post in this chat carries as its participant. */
  function ownJidFor(sock: BaileysSocketLike, chatJid: string): string | undefined {
    const user = sock.user;
    if (!user) return undefined;
    const mode = deps.groupAddressingMode?.(chatJid);
    if (mode === "lid" && user.lid) return user.lid;
    return user.id ?? undefined;
  }

  /**
   * The one door. Refuses without a socket, sends, remembers what went
   * out, and returns the result in the shape `send-result.ts` reads.
   */
  async function send(
    chatJid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
    pin = false,
  ): Promise<BaileysSendResult | undefined> {
    const sock = deps.getSocket();
    if (!sock) throw new NotConnectedError();
    const sent = await sock.sendMessage(chatJid, content, options);
    // Undefined stays undefined, so the scheduler's CRITICAL
    // missing-result line still fires exactly as it did.
    if (!sent) return undefined;
    store.remember(sent, { pin });
    const key = completeOwnKey(sent.key, ownJidFor(sock, chatJid));
    const id = serializeKey(key);
    return id ? { id: { _serialized: id }, key, message: sent } : { key, message: sent };
  }

  return {
    name: "baileys",

    // ── Lifecycle ────────────────────────────────────────────────────
    async start() {
      return notYet("start", INBOUND);
    },

    async close() {
      // end(), never logout(). logout() unlinks the device.
      let sock: BaileysSocketLike | null | undefined;
      try {
        sock = deps.getSocket();
      } catch {
        return;
      }
      sock?.end(undefined);
    },

    onOpen() {
      notYet("onOpen", INBOUND);
    },

    onClose() {
      notYet("onClose", INBOUND);
    },

    // ── Identity ─────────────────────────────────────────────────────
    selfId() {
      return notYet(
        "selfId",
        `${INBOUND} Note sock.user.id carries a device suffix that must be stripped first (§2.4).`,
      );
    },

    selfIdentities() {
      return notYet("selfIdentities", INBOUND);
    },

    async selfIds() {
      return notYet("selfIds", PHASE_4);
    },

    // ── Inbound ──────────────────────────────────────────────────────
    onMessage() {
      notYet("onMessage", INBOUND);
    },

    onReaction() {
      notYet("onReaction", INBOUND);
    },

    onPollVote() {
      notYet("onPollVote", PHASE_4);
    },

    onGroupJoin() {
      notYet("onGroupJoin", PHASE_4);
    },

    onGroupLeave() {
      notYet("onGroupLeave", PHASE_4);
    },

    // ── Outbound ─────────────────────────────────────────────────────
    sendText(chatId, text) {
      return send(wireChatJid(chatId), textContent(text));
    },

    sendTextWithMentions(chatId, text, mentionPhones) {
      return send(wireChatJid(chatId), mentionContent(text, mentionPhones));
    },

    async sendDirectText(phone, text) {
      const jid = toUserJid(String(phone ?? ""));
      if (!phoneFromJid(jid)) {
        throw new Error(
          `[baileys driver] sendDirectText: ${JSON.stringify(phone)} is not a phone number, ` +
            "so there is nobody to DM",
        );
      }
      return send(jid, textContent(text));
    },

    sendPoll(chatId, question, options, allowMultipleAnswers) {
      // Pinned: votes are decrypted against this message for a day and a
      // half after kickoff (§2.12).
      return send(
        wireChatJid(chatId),
        pollContent(question, options, allowMultipleAnswers),
        undefined,
        true,
      );
    },

    async sendReaction(waMessageId, emoji): Promise<ReactionOutcome> {
      // Never throws: the attendance write already happened, and a
      // reaction is only its confirmation.
      const key = parseKey(waMessageId);
      if (!key) {
        return {
          ok: false,
          reason: "unparseable-id",
          detail: `not a whatsapp-web.js message id: ${String(waMessageId).slice(0, 120)}`,
        };
      }
      try {
        await send(key.remoteJid, reactionContent(key, emoji));
      } catch (err) {
        if (err instanceof NotConnectedError) return { ok: false, reason: "not-connected" };
        return { ok: false, reason: "send-threw", detail: errorText(err) };
      }
      return { ok: true };
    },

    async replyTo(msg, text) {
      // Under Baileys the inbound message handed up to the bot is the
      // WAMessage itself (the inbound wiring must keep it that way), and a
      // quote needs all of it, not just the id.
      const raw = msg as unknown as WAMessage;
      const chat = raw?.key?.remoteJid;
      if (!chat) {
        throw new Error(
          "[baileys driver] replyTo: the message has no key.remoteJid, so there is no chat to " +
            "reply in",
        );
      }
      await send(chat, textContent(text), { quoted: raw });
    },

    async sendTextViaChat() {
      // See the header: a second attempt down the same path can only fail
      // again or post the reply twice.
      throw new BaileysDriverUnsupportedError(
        "sendTextViaChat",
        "no-baileys-equivalent",
        "Baileys has one send path, and sendText has just failed on it. Retrying the same " +
          "path could only fail again or, if the first send got out, post the reply twice, so " +
          "this refuses instead.",
      );
    },

    // ── Groups and roster ────────────────────────────────────────────
    async listGroups() {
      return notYet("listGroups", PHASE_4);
    },

    async groupParticipants() {
      return notYet("groupParticipants", PHASE_4);
    },

    async groupSnapshot() {
      return notYet("groupSnapshot", PHASE_4);
    },

    async getContact() {
      return notYet(
        "getContact",
        `${PHASE_4} Baileys has no contact lookup; names are harvested, never fetched (§2.9).`,
      );
    },

    async contactOf() {
      return notYet("contactOf", `${INBOUND} The sender's name is msg.pushName (§2.9).`);
    },

    // ── History and recovery ─────────────────────────────────────────
    async fetchRecentGroupMessages() {
      return notYet("fetchRecentGroupMessages", HISTORY);
    },

    async listDmChats() {
      throw new BaileysDriverUnsupportedError(
        "listDmChats",
        "no-baileys-equivalent",
        "Baileys keeps no chat store, so there are no DM chats to list (plan §1.4 item 43). " +
          "Unset BOT_RECOVER_DM_REPLIES; recover DM replies with a script against the database.",
      );
    },

    // ── Not on WaDriver ──────────────────────────────────────────────
    async getMessage(key) {
      return store.get(key);
    },
  };
}
