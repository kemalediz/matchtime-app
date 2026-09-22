/**
 * The Baileys driver: lifecycle, identity, inbound and outbound.
 *
 * ── Where this sits ─────────────────────────────────────────────────
 * `MDs/baileys-migration-plan-2026-09-21.md`. Phase 3 built the six sends
 * the bot makes (`sendText`, `sendTextWithMentions`, `sendDirectText`,
 * `sendPoll`, `sendReaction`, `replyTo`), the key serialiser they rest on
 * and the bounded store Baileys' `getMessage` reads. Phase 3b (this file's
 * second half) adds what Phase 3 found no phase owned: the socket
 * lifecycle, the bot's three notions of itself, and message receipt.
 *
 * It is still NOT reachable. `driver-select.ts` refuses `WA_DRIVER=baileys`
 * until Phase 4 (groups, participants, join and leave, polls) lands,
 * because a bot that can hear messages but cannot see its own groups would
 * come up blind, and blind looks like healthy. Nothing here changes what
 * the Pi runs.
 *
 * ── The socket is owned by a connection, and injected ───────────────
 * `baileys/lifecycle.ts` builds, pairs, watches and rebuilds the socket
 * (generation counter, `decideOnClose`, a logged-out latch, a persisted
 * pairing-code budget). This file takes it as `deps.connection`, so every
 * line runs in a test against `baileys/fake-socket.ts`. `createBaileysDriver`
 * at the bottom is the only place a real socket is built, and no test
 * calls it. Sends go to `connection.openSocket()`, which is null unless the
 * socket is OPEN, so a send during a reconnect throws rather than hanging.
 *
 * ── The three notions of self (Phase 2 found the code needs all three) ──
 *   selfId()          the phone JID, `447...@c.us`. Compared with
 *                     participant ids and join/leave recipients, and with
 *                     mentions in the setup trigger.
 *   selfIdentities()  every form, selfId first: phone JID and LID. The live
 *                     list the @-mention check (`rewriteMentions`) matches.
 *   selfIds()         phone JID and LID for self-add detection, cached once
 *                     BOTH are known (never a partial answer: a cached
 *                     phone-only list would miss every LID-addressed group
 *                     for the life of the process).
 * All three come from `sock.user` with the device suffix stripped (§2.4)
 * and in whatsapp-web.js spelling, because every comparison above the seam
 * is a string comparison written for that spelling. Under Baileys
 * `selfIdentities` and `selfIds` carry the same two ids; whatsapp-web.js
 * needed them apart (`info.me`, a page read for the LID) and Baileys does
 * not. They could be collapsed; that is a separate, reviewable change,
 * not this one. None of the three throws: there is no throwing getter to
 * inherit, and before the first open they are simply unknown.
 *
 * ── Inbound ─────────────────────────────────────────────────────────
 * Every `messages.upsert` message, whatever its `type`, is logged with that
 * type and its age, and NOTHING is filtered on the type. Whether messages
 * sent while the bot was down come back, and as `notify` or `append`, is
 * the open measurement (§2.15) that decides the restart replay's fate;
 * HomeTenant cannot answer it because it drops everything but `notify`.
 * Duplicates and skipped types get a line too, so a replay can be counted.
 *
 * What is handed up is `baileys/inbound-view.ts`'s view: the fields
 * `wa-read.ts` and `message-id.ts` have always read, with the raw
 * `WAMessage` behind it for `replyTo`. A batch is processed in order, so an
 * offline replay reaches the analyzer oldest first.
 *
 * Reactions go through `baileys/reaction.ts`, which turns a DM target under
 * a LID back into the phone form the database stored before serialising
 * it. When it cannot, the reaction goes up with no id: the exact shape
 * `index.ts` records as `reaction-forwarding` degraded, so the failure
 * reaches the server's health check like a whatsapp-web.js one does, and
 * is logged CRITICAL and counted here.
 *
 * `getContact` and `contactOf` answer from names HARVESTED off inbound
 * messages and `contacts.upsert` (`baileys/contacts.ts`) and from Baileys'
 * LOCAL LID store, never from WhatsApp. For a sender nobody has named, they
 * return a record with no `pushname` and no `name` (and no `number` for an
 * unmapped LID), which every caller already reads as "unknown" and falls
 * back from.
 *
 * ── Every send goes through one door ────────────────────────────────
 * `send()` is the only caller of `sock.sendMessage`. It refuses when
 * there is no open socket (throwing, so the scheduler sees a failed send
 * rather than acking one that never went out), and it records what was
 * sent for `getMessage`. Every text is built by `textContent` or
 * `mentionContent`, which set `linkPreview: null` (§2.6).
 *
 * The scheduler reads a sent message's id with `send-result.ts`, which
 * wants `result.id._serialized`, so each send resolves to a small wrapper
 * carrying the whatsapp-web.js-format id from `serializeKey` (§2.5), after
 * `completeOwnKey` has put OUR JID on our own group posts. The reaction
 * path puts our JID on a reaction to our own post with the SAME function,
 * `ownJidFor`, so the two sides of that join cannot drift apart.
 *
 * ── What this driver refuses, and why ───────────────────────────────
 *   sendTextViaChat  REFUSED, deliberately. The group reply calls it only
 *                    after `sendText` has THROWN; under Baileys a second
 *                    attempt down the same path can only fail again or,
 *                    when the first send got out before it threw, post the
 *                    reply twice (the 2026-07-19 flood was 30+ copies).
 *   listDmChats      No Baileys equivalent: there is no chat store (§2.14).
 *   groups, polls,   Phase 4, and the restart replay is Phase 5's call.
 *   history          Each throws by name, never returns an empty value:
 *                    several callers read an empty roster as "healthy",
 *                    and those throws are how `degraded.ts` hears about it.
 *
 * ── Two rules, never broken ─────────────────────────────────────────
 * `close()` ends the socket and never calls `logout()`, which unlinks the
 * device and costs a re-pair (§2.10). And nothing here ever asks WhatsApp
 * about a number (§2.2): a hundred such lookups got every linked device on
 * HomeTenant's account unlinked on 2026-09-17.
 */
import makeWASocket, {
  makeCacheableSignalKeyStore,
  // Aliased: the repo's eslint runs React's rules-of-hooks over everything
  // and reads any `useX()` as a hook. See `baileys/main.ts`.
  useMultiFileAuthState as loadMultiFileAuthState,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WAMessageKey,
  type proto,
} from "baileys";
import qrcode from "qrcode-terminal";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InboundMessage, WaDriver } from "../driver.js";
import type { ReactionOutcome } from "../react-with-id.js";
import { acquireInstanceLock } from "../instance-lock.js";
import { legacyJid, parseKey, serializeKey } from "../baileys/key.js";
import {
  completeOwnKey,
  mentionContent,
  pollContent,
  reactionContent,
  textContent,
} from "../baileys/outbound.js";
import { createSentMessageStore, type SentMessageStore } from "../baileys/sent-store.js";
import {
  inboundDropReason,
  isLidJid,
  lidLookupJid,
  phoneFromJid,
  resolveInboundSender,
  toUserJid,
  type InboundKeyLike,
} from "../baileys/jid.js";
import { createSeenIds } from "../baileys/dedupe.js";
import { mapInboundMessage, skipReason, toNumber } from "../baileys/inbound.js";
import { buildInboundView, rawOf, type BaileysInboundView } from "../baileys/inbound-view.js";
import { mapReaction, type ReactionEvent } from "../baileys/reaction.js";
import { createContactDirectory, type ContactDirectory } from "../baileys/contacts.js";
import { createBaileysConnection, type BaileysConnection, type LifecycleSocket } from "../baileys/lifecycle.js";
import { createSessionLedger, fileLedgerIO } from "../baileys/session-ledger.js";
import { resolveBaileysConfig } from "../baileys/config.js";
import { makeBaileysLogger } from "../baileys/logging.js";

/** The part of Baileys' `WASocket` this driver touches. */
export interface BaileysSocketLike extends LifecycleSocket {
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<WAMessage | undefined>;
  end(error: Error | undefined): void;
  /** LOCAL mapping store only; `getPNForLID` has no network path. */
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } };
}

export interface BaileysDriverDeps {
  /**
   * The live socket, or null. Defaults to `connection.openSocket()`. Given
   * on its own (no connection), the driver can send but has no lifecycle
   * and no inbound path: the Phase 3 shape, kept for the outbound tests.
   */
  getSocket?(): BaileysSocketLike | null | undefined;
  /** Owns the socket's lifecycle and fans its events out (Phase 3b). */
  connection?: BaileysConnection<BaileysSocketLike>;
  /**
   * How a group addresses its members, when known. Decides which of our
   * ids goes into our own group posts' stored ids, and into the ids of
   * reactions to them: the LID in a LID-addressed group, the phone JID
   * otherwise, as whatsapp-web.js did.
   *
   * Phase 4 supplies this from its `cachedGroupMetadata`
   * (`GroupMetadata.addressingMode`). Until then it is absent and the
   * phone form is used on BOTH sides, so reactions to our own posts made
   * under Baileys still join; what can miss is a reaction on a post the
   * whatsapp-web.js bot made in a LID-addressed group before the cutover.
   */
  groupAddressingMode?(groupJid: string): "lid" | "pn" | undefined;
  /** Injected for tests; defaults to a fresh bounded store. */
  store?: SentMessageStore<proto.IMessage>;
  /** Injected for tests; defaults to a fresh bounded directory. */
  contacts?: ContactDirectory;
  log?(line: string): void;
  error?(line: string): void;
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

/** Per-process tallies of the inbound path, for tests and for the log. */
export interface BaileysInboundStats {
  /** Messages seen, by upsert type. The Phase 5 measurement reads this. */
  upserts: Record<string, number>;
  delivered: number;
  skipped: number;
  duplicates: number;
  /** Handed up with a LID author because no phone could be found. */
  unresolvedSenders: number;
  reactionsForwarded: number;
  /** Real reactions whose target could not be turned into the stored id. */
  unresolvedReactionTargets: number;
  ownReactionsIgnored: number;
}

export interface BaileysDriver extends WaDriver {
  /**
   * For `makeWASocket({ getMessage })`: the message we sent with this key,
   * so Baileys can re-encrypt it when a recipient asks for a retry, and so
   * Phase 4 can decrypt votes on a poll.
   */
  getMessage(key: Pick<WAMessageKey, "id"> | null | undefined): Promise<proto.IMessage | undefined>;
  stats(): BaileysInboundStats;
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
const HISTORY =
  "Whether the restart replay is needed at all under Baileys is the plan's open measurement " +
  "(§2.15, the experiment under Phase 3b, run first in Phase 5); build it after that, on " +
  "fetchMessageHistory if at all.";

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

type SelfUser = { id?: string | null; lid?: string | null } | null | undefined;

function emptyStats(): BaileysInboundStats {
  return {
    upserts: {},
    delivered: 0,
    skipped: 0,
    duplicates: 0,
    unresolvedSenders: 0,
    reactionsForwarded: 0,
    unresolvedReactionTargets: 0,
    ownReactionsIgnored: 0,
  };
}

export function makeBaileysDriver(deps: BaileysDriverDeps): BaileysDriver {
  const store = deps.store ?? createSentMessageStore<proto.IMessage>();
  const contacts = deps.contacts ?? createContactDirectory();
  const conn = deps.connection;
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const getSocket = deps.getSocket ?? (() => conn?.openSocket() ?? null);
  const stats = emptyStats();
  const firstSighting = createSeenIds();
  const messageHandlers: Array<(msg: InboundMessage) => void | Promise<void>> = [];
  const reactionHandlers: Array<(reaction: unknown) => void | Promise<void>> = [];
  let cachedSelfIds: string[] | null = null;

  function requireConnection(member: keyof WaDriver): BaileysConnection<BaileysSocketLike> {
    if (!conn) {
      throw new Error(
        `[baileys driver] ${member}: no connection is wired into this driver, so it cannot ` +
          "start or hear anything. Build it with createBaileysDriver().",
      );
    }
    return conn;
  }

  function safeSocket(): BaileysSocketLike | null {
    try {
      return getSocket() ?? null;
    } catch {
      return null;
    }
  }

  /** Any socket, open or not: the local LID store survives a reconnect gap. */
  function anySocket(): BaileysSocketLike | null {
    try {
      return conn?.latestSocket() ?? safeSocket();
    } catch {
      return null;
    }
  }

  function currentUser(): SelfUser {
    try {
      return conn?.user() ?? safeSocket()?.user ?? null;
    } catch {
      return null;
    }
  }

  /** Our ids in the spelling everything above the seam compares. */
  function me(): { pn: string | null; lid: string | null } {
    const user = currentUser();
    return { pn: legacyJid(user?.id), lid: legacyJid(user?.lid) };
  }

  /**
   * Which of our ids a post in this chat carries as its participant. ONE
   * function for both sides of the join: the send path completes our own
   * keys with it, and the reaction path rewrites a reaction's target with
   * it.
   */
  function ownJidFor(user: SelfUser, chatJid: string): string | undefined {
    if (!user) return undefined;
    const mode = deps.groupAddressingMode?.(chatJid);
    if (mode === "lid" && user.lid) return user.lid;
    return user.id ?? undefined;
  }

  /**
   * Phone digits for a LID, from what we have been TOLD: the harvested
   * directory, then Baileys' local mapping store. Never the network: this
   * direction (`getPNForLID`) has no network path in Baileys at all. May
   * throw if the store does; every caller catches.
   */
  async function phoneForLid(lidJid: string): Promise<string | null> {
    const known = contacts.phoneForLid(lidJid);
    if (known) return known;
    const lookup = lidLookupJid(lidJid);
    const repo = anySocket()?.signalRepository?.lidMapping;
    if (!lookup || !repo) return null;
    const pn = await repo.getPNForLID(lookup);
    const phone = phoneFromJid(pn);
    if (phone) contacts.learnPair(lookup, toUserJid(phone));
    return phone;
  }

  async function senderPhoneOf(key: InboundKeyLike): Promise<ReturnType<typeof resolveInboundSender>> {
    return resolveInboundSender(key, async (lid) => {
      const phone = await phoneForLid(lid);
      return phone ? toUserJid(phone) : null;
    });
  }

  /** A contact record in the shape the callers read. Never throws, never asks WhatsApp. */
  async function contactRecord(
    jid: string | null | undefined,
    hint: { phone?: string | null; pushname?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const key = legacyJid(jid);
    const names = contacts.namesFor(key);
    let phone = hint.phone ?? phoneFromJid(key);
    if (!phone && key && isLidJid(key)) {
      try {
        phone = await phoneForLid(key);
      } catch {
        phone = null;
      }
    }
    const self = me();
    return {
      id: { _serialized: key ?? "" },
      number: phone ?? undefined,
      pushname: hint.pushname ?? names.pushname,
      name: names.name,
      verifiedName: names.verifiedName,
      shortName: undefined,
      isMe: !!key && (key === self.pn || key === self.lid),
    };
  }

  // ── Inbound wiring ───────────────────────────────────────────────────

  /** A batch at a time, in order, so a replay reaches the analyzer oldest first. */
  let inboundChain: Promise<void> = Promise.resolve();
  let reactionChain: Promise<void> = Promise.resolve();

  function ageOf(m: WAMessage): string {
    const ts = toNumber(m?.messageTimestamp);
    return ts > 0 ? String(Math.max(0, Math.round(Date.now() / 1000 - ts))) : "?";
  }

  function hand<T>(handlers: Array<(arg: T) => void | Promise<void>>, arg: T, what: string): void {
    for (const h of handlers) {
      try {
        void Promise.resolve(h(arg)).catch((err) =>
          error(`[baileys] ${what} handler failed: ${errorText(err)}`),
        );
      } catch (err) {
        error(`[baileys] ${what} handler failed: ${errorText(err)}`);
      }
    }
  }

  async function receive(m: WAMessage, upsertType: string, requestId?: string): Promise<void> {
    stats.upserts[upsertType] = (stats.upserts[upsertType] ?? 0) + 1;
    const key = m?.key ?? {};
    // Learn first, from every message, including the ones not handed up: a
    // reaction arrives as a message too, and its pushName names a reactor
    // who may never type.
    contacts.learnFromMessage(key, m?.pushName);

    const line =
      `[baileys][msg] upsert=${upsertType}${requestId ? ` requestId=${requestId}` : ""} ` +
      `chat=${key.remoteJid ?? "?"} id=${key.id ?? "?"} age=${ageOf(m)}s`;

    const drop = inboundDropReason(key, { keepOwn: true });
    if (drop) {
      stats.skipped++;
      log(`${line} skipped: ${drop}`);
      return;
    }
    const mapped = mapInboundMessage(m);
    if (!mapped) {
      stats.skipped++;
      log(`${line} skipped: ${skipReason(m)}`);
      return;
    }
    if (!firstSighting(`${mapped.chatJid}|${mapped.id}`)) {
      stats.duplicates++;
      log(`${line} duplicate delivery, not handed up again`);
      return;
    }

    let senderPhone: string | null = null;
    let source = "";
    if (mapped.senderJid && !mapped.fromMe) {
      const who = await senderPhoneOf(key);
      if (who.phone !== null) {
        senderPhone = who.phone;
        source = who.source;
      } else {
        stats.unresolvedSenders++;
        error(
          `[baileys][msg] sender UNRESOLVED for ${mapped.id}: ${who.reason}` +
            `${who.lid ? ` (lid ${who.lid})` : ""}. Handed up under the LID; the server will ` +
            "try the pushname.",
        );
      }
    }

    const view: BaileysInboundView = buildInboundView(m, mapped, { upsertType, senderPhone });
    stats.delivered++;
    log(
      `${line} group=${mapped.isGroup} fromMe=${mapped.fromMe} ` +
        `sender=${view.baileys.senderJid ?? "?"} phone=${senderPhone ?? "?"}${source ? `(${source})` : ""} ` +
        `name=${mapped.pushName ?? "?"} type=${mapped.type} bodyLen=${mapped.body.length} ` +
        `media=${mapped.hasMedia} mentions=${mapped.mentionedJids.length}`,
    );
    hand(messageHandlers, view as InboundMessage, "onMessage");
  }

  async function receiveReaction(evt: ReactionEvent): Promise<void> {
    const mapped = await mapReaction(evt, {
      ownJidFor: (chat) => ownJidFor(currentUser(), chat),
      phoneForLid,
    });
    if (mapped.kind === "own") {
      stats.ownReactionsIgnored++;
      return;
    }
    const { payload, unresolved } = mapped;
    if (unresolved) {
      stats.unresolvedReactionTargets++;
      error(
        `CRITICAL: [baileys][reaction] a ${payload.reaction} reaction from ${payload.senderId || "?"} ` +
          `could not be joined to the message it was on: ${unresolved.reason}` +
          `${unresolved.lid ? ` (chat ${unresolved.lid})` : ""}. It is handed up with no id, so ` +
          "index.ts records reaction-forwarding degraded; the stored id would have been the " +
          `phone form, not ${unresolved.wouldHaveBeen ?? "the LID form"}. Occurrence ` +
          `#${stats.unresolvedReactionTargets}.`,
      );
    }
    stats.reactionsForwarded++;
    log(
      `[baileys][reaction] ${payload.reaction || "(removed)"} from=${payload.senderId || "?"} ` +
        `on=${payload.msgId?._serialized ?? "UNRESOLVED"}`,
    );
    hand(reactionHandlers, payload as unknown, "onReaction");
  }

  if (conn) {
    conn.on("messages.upsert", ({ messages, type, requestId }) => {
      const batch = Array.isArray(messages) ? [...messages] : [];
      const upsertType = String(type ?? "?");
      inboundChain = inboundChain
        .then(async () => {
          for (const m of batch) {
            try {
              await receive(m, upsertType, requestId);
            } catch (err) {
              error(`[baileys][msg] could not process ${m?.key?.id ?? "?"}: ${errorText(err)}`);
            }
          }
        })
        .catch((err) => error(`[baileys][msg] batch failed: ${errorText(err)}`));
    });

    conn.on("messages.reaction", (events) => {
      const batch = Array.isArray(events) ? [...events] : [];
      reactionChain = reactionChain
        .then(async () => {
          for (const evt of batch) {
            try {
              await receiveReaction(evt as ReactionEvent);
            } catch (err) {
              error(`[baileys][reaction] could not process a reaction: ${errorText(err)}`);
            }
          }
        })
        .catch((err) => error(`[baileys][reaction] batch failed: ${errorText(err)}`));
    });

    conn.on("contacts.upsert", (list) => {
      for (const c of Array.isArray(list) ? list : []) contacts.learnContact(c);
    });
    conn.on("contacts.update", (list) => {
      for (const c of Array.isArray(list) ? list : []) contacts.learnContact(c);
    });
    conn.on("lid-mapping.update", (m) => contacts.learnPair(m?.lid, m?.pn));
  }

  /**
   * The one door. Refuses without an open socket, sends, remembers what
   * went out, and returns the result in the shape `send-result.ts` reads.
   */
  async function send(
    chatJid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
    pin = false,
  ): Promise<BaileysSendResult | undefined> {
    const sock = getSocket();
    if (!sock) throw new NotConnectedError();
    const sent = await sock.sendMessage(chatJid, content, options);
    // Undefined stays undefined, so the scheduler's CRITICAL
    // missing-result line still fires exactly as it did.
    if (!sent) return undefined;
    store.remember(sent, { pin });
    const key = completeOwnKey(sent.key, ownJidFor(sock.user, chatJid));
    const id = serializeKey(key);
    return id ? { id: { _serialized: id }, key, message: sent } : { key, message: sent };
  }

  return {
    name: "baileys",

    // ── Lifecycle ────────────────────────────────────────────────────
    async start() {
      await requireConnection("start").start();
    },

    async close() {
      // end(), never logout(). logout() unlinks the device.
      if (conn) {
        await conn.close();
        return;
      }
      const sock = safeSocket();
      try {
        sock?.end(undefined);
      } catch {
        /* already closed */
      }
    },

    onOpen(handler) {
      requireConnection("onOpen").onOpen(handler);
    },

    onClose(handler) {
      requireConnection("onClose").onClose(handler);
    },

    // ── Identity ─────────────────────────────────────────────────────
    selfId() {
      return me().pn ?? undefined;
    },

    selfIdentities() {
      const self = me();
      return [self.pn ?? undefined, self.lid ?? undefined];
    },

    async selfIds() {
      if (cachedSelfIds) return cachedSelfIds;
      const self = me();
      const ids = [self.pn, self.lid].filter((s): s is string => !!s);
      if (self.pn && self.lid) cachedSelfIds = ids;
      return ids;
    },

    // ── Inbound ──────────────────────────────────────────────────────
    onMessage(handler) {
      requireConnection("onMessage");
      messageHandlers.push(handler);
    },

    onReaction(handler) {
      requireConnection("onReaction");
      reactionHandlers.push(handler);
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
      // A quote needs the whole WAMessage, not just the id. What onMessage
      // hands up is a view with the raw message behind it; a bare
      // WAMessage is accepted as itself.
      const raw = rawOf(msg);
      const chat = raw?.key?.remoteJid;
      if (!raw || !chat) {
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

    getContact(jid) {
      return contactRecord(jid);
    },

    async contactOf(msg) {
      const facts = (msg as Partial<BaileysInboundView> | null | undefined)?.baileys;
      if (facts) {
        return contactRecord(facts.senderJid, { phone: facts.senderPhone, pushname: facts.pushName });
      }
      // A bare WAMessage (the history path, one day): resolve it the same way.
      const raw = rawOf(msg);
      if (!raw) return contactRecord(null);
      const key = raw.key ?? {};
      const sender = key.participant || key.remoteJid;
      let phone: string | null = null;
      try {
        phone = (await senderPhoneOf(key)).phone;
      } catch {
        phone = null;
      }
      return contactRecord(sender, { phone, pushname: raw.pushName ?? null });
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

    stats() {
      return { ...stats, upserts: { ...stats.upserts } };
    },
  };
}

// ── The real thing ────────────────────────────────────────────────────

const BOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The Baileys process lock. Its OWN path, not `index.ts`'s
 * `/tmp/matchtime-bot.pid`, and the same one Phase 1's observer takes: two
 * sockets on one auth folder evict each other in a 440 loop, so the
 * observer and a Baileys-driven bot must never run at once.
 */
const DEFAULT_BAILEYS_LOCK_PATH = "/tmp/matchtime-baileys.pid";

/** Pairing requests and the logged-out latch, kept beside the keys. */
const LEDGER_FILE = "matchtime-session-ledger.json";

/**
 * Build the real Baileys driver. NOT reachable yet: `driver-select.ts`
 * refuses `WA_DRIVER=baileys` until Phase 4. Building it opens nothing;
 * the first socket is built, and connects, only in `start()`.
 *
 * No test calls this: `makeWASocket` connects the moment it is called.
 * `baileys.source.test.ts` pins its options instead.
 */
export function createBaileysDriver(env: NodeJS.ProcessEnv = process.env): BaileysDriver {
  const config = resolveBaileysConfig(env, BOT_DIR);
  const logger = makeBaileysLogger(config.logLevel);
  console.log(
    `Baileys driver: session ${config.authDir} | log level ${config.logLevel} | ` +
      `login ${config.pairPhone ? `pairing code for ${config.pairPhone}` : "QR"}`,
  );

  async function prepare() {
    const lock = acquireInstanceLock({ path: env.MT_BAILEYS_LOCK_PATH ?? DEFAULT_BAILEYS_LOCK_PATH });
    if (!lock.acquired) {
      throw new Error(
        `CRITICAL: another Baileys process already holds this session (pid ${lock.holderPid}). ` +
          "Two sockets on one auth folder evict each other in a 440 loop. Stop the Phase 1 " +
          "observer (npm run start:baileys) or the other bot first.",
      );
    }
    // 0700: this directory is the whole session. Never deleted by us.
    await mkdir(config.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await loadMultiFileAuthState(config.authDir);
    // An LRU in front of the multi-file store: without it every Signal
    // operation is a directory read on an SD card.
    const keys = makeCacheableSignalKeyStore(state.keys, logger);
    return { state, saveCreds, keys };
  }
  let prepared: ReturnType<typeof prepare> | null = null;

  // Declared before the connection so the socket factory can reach
  // getMessage; assigned straight after.
  let driver: BaileysDriver | null = null;

  const connection = createBaileysConnection<BaileysSocketLike>({
    makeSocket: async () => {
      prepared ??= prepare();
      const { state, saveCreds, keys } = await prepared;
      const sock = makeWASocket({
        auth: { creds: state.creds, keys },
        logger,
        // Default TRUE: the phone would stop getting push notifications.
        markOnlineOnConnect: false,
        // Default TRUE: a full history pull onto a Pi. Phase 5 decides
        // whether we need any of it.
        syncFullHistory: false,
        getMessage: (key) => driver?.getMessage(key) ?? Promise.resolve(undefined),
      });
      sock.ev.on("creds.update", () => void saveCreds());
      return sock as unknown as BaileysSocketLike;
    },
    pairPhone: config.pairPhone,
    ledger: createSessionLedger(fileLedgerIO(join(config.authDir, LEDGER_FILE))),
    printQr: (qr) => qrcode.generate(qr, { small: true }),
  });

  driver = makeBaileysDriver({ connection });
  return driver;
}
