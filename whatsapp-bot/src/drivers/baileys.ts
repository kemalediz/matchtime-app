/**
 * The Baileys driver: lifecycle, identity, inbound and outbound.
 *
 * ── Where this sits ─────────────────────────────────────────────────
 * `MDs/baileys-migration-plan-2026-09-21.md`. Phase 3 built the six sends
 * the bot makes (`sendText`, `sendTextWithMentions`, `sendDirectText`,
 * `sendPoll`, `sendReaction`, `replyTo`), the key serialiser they rest on
 * and the bounded store Baileys' `getMessage` reads. Phase 3b added what
 * Phase 3 found no phase owned: the socket lifecycle, the bot's three
 * notions of itself, and message receipt. Phase 4 adds groups, rosters,
 * joins and leaves, poll votes, and the LID-to-phone bridge.
 *
 * `driver-select.ts` refuses `WA_DRIVER=baileys` unless a second switch
 * is set: `WA_SHADOW=1` (receive-only, every send refused at the driver
 * by `src/shadow.ts`) or `WA_BAILEYS_LIVE=1` (sends enabled, the Phase 6
 * cutover, Kemal's decision after the shadow run on the real number).
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
 *
 * ── The restart replay (Phase 5) ─────────────────────────────────────
 * `fetchRecentGroupMessages` no longer refuses. It is served from
 * `baileys/replay.ts`, a bounded per-chat buffer of what the socket
 * actually delivered, after a short settle window so it does not race
 * WhatsApp's own reconnect delivery. That is the version that works IF
 * the offline replay happens, which is still the plan's open measurement
 * (§2.15). It reports what it served rather than throwing when it has
 * nothing, because a CRITICAL line on every quiet restart is how a log
 * stops being read; the signal is in `stats()` (`historyServed`,
 * `historyEmpty`, `sinceOpen`) and in the `[baileys][history]` line.
 *
 * ── Groups and the LID-to-phone bridge (Phase 4) ─────────────────────
 * `listGroups` reads `groupFetchAllParticipating`; `groupParticipants` and
 * `groupSnapshot` read `groupMetadata`, which is the only NETWORK path from
 * a LID to a phone (§2.7). Every roster read, and every join, feeds
 * `seedFrom`: the pairs go into the harvested directory AND into Baileys'
 * own mapping store via `storeLIDPNMappings`, because rc14 ships
 * `// TODO: Store LID MAPPINGS` and never seeds it itself. Rosters go up in
 * PHONE form wherever a phone is known, so `index.ts` posts phones exactly
 * as it did under whatsapp-web.js. `baileys/groups.ts` has the detail.
 *
 * Both listing members honour the throw contract in `driver.ts`: a failed
 * read throws, so `group-enumeration` and `participant-sync` still reach
 * the heartbeat. A read younger than `GROUP_SWEEP_INTERVAL_MS` (15 min) is
 * served from the cache instead of asking WhatsApp again, so a flapping
 * line does not re-read every roster on every reconnect; the cache is kept
 * exact by `group-participants.update` while connected. The same cache
 * answers Baileys' `cachedGroupMetadata`, but only for a read made in the
 * CURRENT connection: across a reconnect Baileys fetches for itself,
 * because a stale roster would encrypt a group post for the wrong people.
 * The cache also knows each group's addressing mode, which decides which
 * of our ids goes on our own group posts (`ownJidFor`).
 *
 * ── Poll votes (Phase 4) ─────────────────────────────────────────────
 * rc14 does not decrypt votes (the branch is commented out), so
 * `baileys/polls.ts` does it from the `messages.upsert` that carries the
 * encrypted `pollUpdateMessage`, against the poll we sent. Polls are kept
 * in memory AND in an archive beside the auth state, because a MoM vote
 * can arrive a day and a half after the poll and a restart in between must
 * not cost it.
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
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WAMessageKey,
  type proto,
} from "baileys";
import qrcode from "qrcode-terminal";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupMembershipEvent, InboundMessage, InboundPollVote, WaDriver } from "../driver.js";
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
import { createReplayBuffer, type ReplayBuffer } from "../baileys/replay.js";
import { mapInboundMessage, skipReason, toNumber } from "../baileys/inbound.js";
import { buildInboundView, rawOf, type BaileysInboundView } from "../baileys/inbound-view.js";
import { mapReaction, type ReactionEvent } from "../baileys/reaction.js";
import { createContactDirectory, type ContactDirectory } from "../baileys/contacts.js";
import { createBaileysConnection, type BaileysConnection, type LifecycleSocket } from "../baileys/lifecycle.js";
import { createSessionLedger, fileLedgerIO } from "../baileys/session-ledger.js";
import {
  authorId,
  createGroupCache,
  handedUpId,
  lidPnPairs,
  membershipEvent,
  participantPhone,
  resolveParticipantPhone,
  snapshotFromMetadata,
  type GroupCache,
  type GroupMetaLike,
  type LidPnPair,
  type ParticipantLike,
  type ParticipantsUpdateLike,
} from "../baileys/groups.js";
import { decodePollMessage, describeVia, encodePollMessage, mapPollVote, pollUpdateOf } from "../baileys/polls.js";
import { createPollArchive, type PollArchive } from "../baileys/poll-store.js";
import { createDebouncedWriter, jsonFileIO, type DebouncedWriter } from "../baileys/json-file.js";
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
  /**
   * Baileys' LOCAL mapping store. `getPNForLID` has no network path;
   * `storeLIDPNMappings` is how a roster read seeds it (rc14 never does).
   */
  signalRepository?: {
    lidMapping?: {
      getPNForLID(lid: string): Promise<string | null>;
      storeLIDPNMappings?(pairs: LidPnPair[]): Promise<void>;
    };
  };
  /** One IQ for every group we are in. Its participants may lack phones. */
  groupFetchAllParticipating?(): Promise<Record<string, GroupMetaLike>>;
  /** The roster, with `phoneNumber` for LID-addressed members. */
  groupMetadata?(jid: string): Promise<GroupMetaLike>;
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
   * Defaults to the group cache (`GroupMetadata.addressingMode`, from the
   * listing or a roster read), so a LID-addressed group gets our LID,
   * exactly as whatsapp-web.js chose (`isLidAddressingMode ? lidUser :
   * meUser`), and pre-cutover ids in such a group keep joining. A group not
   * read yet falls back to the phone form on BOTH sides, which still joins
   * for anything sent under Baileys.
   */
  groupAddressingMode?(groupJid: string): "lid" | "pn" | undefined;
  /** Rosters, the group list and addressing modes. Defaults to a fresh cache. */
  groupCache?: GroupCache;
  /** Polls we sent, on disk. Defaults to an in-memory archive. */
  pollArchive?: PollArchive;
  /** Write any pending harvested state to disk. Called on every close. */
  flushState?(): void;
  /**
   * The messages the socket delivered, per chat, bounded. What the
   * restart catch-up (`fetchRecentGroupMessages`) is served from.
   * Defaults to a fresh buffer.
   */
  replay?: ReplayBuffer<InboundMessage>;
  /**
   * How long after an open `fetchRecentGroupMessages` waits before
   * answering, so it does not race WhatsApp's reconnect delivery. See the
   * member for why this exists at all.
   */
  historySettleMs?: number;
  /** Injected for tests, so no test ever sleeps. Defaults to setTimeout. */
  wait?(ms: number): Promise<void>;
  now?(): number;
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
  /**
   * The same tally, CLEARED ON EVERY OPEN.
   *
   * This is the §2.15 measurement in a number rather than a log grep:
   * stop the process, have somebody post, start it, read this. If the
   * offline messages are replayed at all they land in the seconds after
   * an open, and this says how many arrived and under which
   * `messages.upsert` type. An empty record after a reconnect that
   * followed a busy gap is the answer "WhatsApp replayed nothing".
   */
  sinceOpen: Record<string, number>;
  /** Calls to `fetchRecentGroupMessages`. */
  historyRequests: number;
  /** Messages those calls handed back. */
  historyServed: number;
  /** Calls that found nothing to hand back. */
  historyEmpty: number;
  delivered: number;
  skipped: number;
  duplicates: number;
  /** Handed up with a LID author because no phone could be found. */
  unresolvedSenders: number;
  reactionsForwarded: number;
  /** Real reactions whose target could not be turned into the stored id. */
  unresolvedReactionTargets: number;
  ownReactionsIgnored: number;
  /** Group lists read from WhatsApp, and served from the cache. */
  listings: number;
  listingsFromCache: number;
  /** Rosters read from WhatsApp (`groupMetadata`), and served from the cache. */
  rosterReads: number;
  rostersFromCache: number;
  /** LID-to-phone pairs written into Baileys' own store. */
  lidPairsStored: number;
  joins: number;
  leaves: number;
  pollVotesForwarded: number;
  /** Votes on a poll we cannot decrypt (sent before the cutover, or lost). */
  pollVotesUndecryptable: number;
}

export interface BaileysDriver extends WaDriver {
  /**
   * For `makeWASocket({ getMessage })`: the message we sent with this key,
   * so Baileys can re-encrypt it when a recipient asks for a retry, and so
   * Phase 4 can decrypt votes on a poll.
   */
  getMessage(key: Pick<WAMessageKey, "id"> | null | undefined): Promise<proto.IMessage | undefined>;
  /**
   * For `makeWASocket({ cachedGroupMetadata })`: a roster read in THIS
   * connection and still fresh, or undefined so Baileys fetches its own.
   */
  cachedGroupMetadata(jid: string): Promise<GroupMetadata | undefined>;
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

/** The socket is down: nothing was sent, or read. */
class NotConnectedError extends Error {
  override readonly name = "NotConnectedError";
  constructor(what = "nothing was sent") {
    super(`[baileys driver] WhatsApp is not connected, so ${what}`);
  }
}

/** A self-add reported by both `groups.upsert` and a participant add is handed up once. */
const SELF_JOIN_DEDUPE_MS = 2 * 60 * 1000;

/**
 * How long after an open the catch-up waits before answering.
 *
 * `index.ts` runs `recoverGroupMessages` inside its open handler, which
 * fires the instant the socket opens. Anything WhatsApp replays arrives
 * in the seconds AFTER that, so an answer given immediately would report
 * "nothing to catch up on" every single time, whatever the truth turns
 * out to be. Ten seconds is long enough for a reconnect burst and short
 * enough that a deploy does not feel stuck.
 */
const HISTORY_SETTLE_MS = 10_000;

/** What the `[baileys][history]` line tells the reader to go and check. */
const HISTORY_OPEN_QUESTION =
  "whether WhatsApp replays messages sent while the bot was down is the plan's open " +
  "measurement (§2.15, the experiment under Phase 3b, run FIRST in Phase 5). If this served " +
  "0 after a restart that spanned real traffic, the replay did not happen and the catch-up " +
  "has to be rebuilt on sock.fetchMessageHistory";

/** `{notify: 3, append: 1}` as `notify=3 append=1`, or `none`. */
function describeUpserts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(" ") : "none";
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
    sinceOpen: {},
    historyRequests: 0,
    historyServed: 0,
    historyEmpty: 0,
    delivered: 0,
    skipped: 0,
    duplicates: 0,
    unresolvedSenders: 0,
    reactionsForwarded: 0,
    unresolvedReactionTargets: 0,
    ownReactionsIgnored: 0,
    listings: 0,
    listingsFromCache: 0,
    rosterReads: 0,
    rostersFromCache: 0,
    lidPairsStored: 0,
    joins: 0,
    leaves: 0,
    pollVotesForwarded: 0,
    pollVotesUndecryptable: 0,
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
  const pollHandlers: Array<(vote: InboundPollVote) => void | Promise<void>> = [];
  const joinHandlers: Array<(e: GroupMembershipEvent) => void | Promise<void>> = [];
  const leaveHandlers: Array<(e: GroupMembershipEvent) => void | Promise<void>> = [];
  const now = deps.now ?? Date.now;
  const groupCache = deps.groupCache ?? createGroupCache({ now });
  const pollArchive = deps.pollArchive ?? createPollArchive({ io: { load: () => null, save: () => {} }, now });
  const addressingMode = deps.groupAddressingMode ?? ((jid: string) => groupCache.addressingMode(jid));
  /** Bumped on every open: `cachedGroupMetadata` trusts only this connection's reads. */
  let epoch = 0;
  const recentSelfJoins = new Map<string, number>();
  let cachedSelfIds: string[] | null = null;
  const replay = deps.replay ?? createReplayBuffer<InboundMessage>();
  const settleMs = Math.max(0, deps.historySettleMs ?? HISTORY_SETTLE_MS);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** When this connection last opened, so the settle window can be measured. */
  let lastOpenAt = now();

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
    const mode = addressingMode(chatJid);
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

  /** Our ids in legacy spelling, for self checks against rosters. */
  function selfLegacy(): Set<string> {
    const self = me();
    return new Set([self.pn, self.lid].filter((s): s is string => !!s));
  }

  function pollMessage(id: string): proto.IMessage | undefined {
    return store.get({ id }) ?? decodePollMessage(pollArchive.get(id)) ?? undefined;
  }

  // ── Groups and the LID-to-phone bridge ─────────────────────────────────

  /**
   * Learn every LID-to-phone pair these participants carry, and write them
   * into Baileys' OWN store, which rc14 never seeds from group metadata.
   * The pairs are full wire JIDs (`lidPnPairs`): a bare user part or an
   * `@c.us` phone would be skipped by the store without a word. A failed
   * write is logged and does not fail the read: the roster is still good,
   * and the harvested directory already has the pairs.
   */
  async function seedFrom(participants: ReadonlyArray<ParticipantLike | string>, where: string): Promise<number> {
    const pairs = lidPnPairs(participants);
    for (const p of pairs) contacts.learnPair(p.lid, p.pn);
    if (pairs.length === 0) return 0;
    const repo = anySocket()?.signalRepository?.lidMapping;
    if (!repo?.storeLIDPNMappings) {
      error(`[baileys][groups] no mapping store to seed for ${where}; ${pairs.length} pair(s) kept in memory only`);
      return 0;
    }
    try {
      await repo.storeLIDPNMappings(pairs);
      stats.lidPairsStored += pairs.length;
      return pairs.length;
    } catch (err) {
      error(
        `[baileys][groups] storeLIDPNMappings failed for ${where}: ${errorText(err)}. ` +
          `${pairs.length} pair(s) kept in the harvested directory only.`,
      );
      return 0;
    }
  }

  /** A roster from the cache when fresh, else ONE `groupMetadata`. Throws on failure. */
  async function readRoster(groupId: string, member: keyof WaDriver): Promise<GroupMetaLike> {
    const sock = getSocket();
    if (!sock) throw new NotConnectedError(`${member} could not read ${groupId}`);
    const cached = groupCache.verified(groupId);
    if (cached) {
      stats.rostersFromCache++;
      const age = Math.round((groupCache.verifiedAgeMs(groupId) ?? 0) / 1000);
      log(`[baileys][groups] ${groupId} roster served from cache (read ${age}s ago; re-read after 15 min)`);
      return cached;
    }
    if (!sock.groupMetadata) throw new Error(`[baileys driver] ${member}: this socket has no groupMetadata`);
    const meta = await sock.groupMetadata(groupId);
    groupCache.putVerified(meta, epoch);
    stats.rosterReads++;
    const stored = await seedFrom(meta.participants ?? [], groupId);
    let phones = 0;
    let lidOnly = 0;
    for (const p of meta.participants ?? []) {
      if (participantPhone(p)) phones++;
      else lidOnly++;
    }
    log(
      `[baileys][groups] ${groupId} ${JSON.stringify(meta.subject ?? "")} (addressing ${meta.addressingMode ?? "?"}): ` +
        `${(meta.participants ?? []).length} participant(s), ${phones} with a phone from WhatsApp, ` +
        `${lidOnly} LID only; ${stored} LID-phone pair(s) stored`,
    );
    return meta;
  }

  function handJoin(event: GroupMembershipEvent, self: boolean): void {
    if (self && event.chatId) {
      const last = recentSelfJoins.get(event.chatId);
      if (last !== undefined && now() - last < SELF_JOIN_DEDUPE_MS) {
        log(`[baileys][groups] self-add in ${event.chatId} already handed up; not twice`);
        return;
      }
      recentSelfJoins.set(event.chatId, now());
    }
    stats.joins++;
    hand(joinHandlers, event, "onGroupJoin");
  }

  async function receiveParticipants(update: ParticipantsUpdateLike): Promise<void> {
    if (!update?.id) return;
    await seedFrom(update.participants ?? [], `${update.action} in ${update.id}`);
    const self = selfLegacy();
    groupCache.applyParticipants(update, self);
    const mapped = await membershipEvent(update, { phoneForLid });
    if (!mapped) return;
    const ids = mapped.event.recipientIds ?? [];
    log(
      `[baileys][groups] ${mapped.kind} in ${update.id}: [${ids.join(", ")}] author=${mapped.event.author ?? "?"}`,
    );
    if (mapped.kind === "join") {
      handJoin(mapped.event, ids.some((id) => self.has(id)));
    } else {
      stats.leaves++;
      hand(leaveHandlers, mapped.event, "onGroupLeave");
    }
  }

  /** A group created with us in it. Reported as one self-add join. */
  async function receiveGroupUpsert(meta: GroupMetaLike): Promise<void> {
    if (!meta?.id) return;
    groupCache.putVerified(meta, epoch);
    await seedFrom(meta.participants ?? [], `new group ${meta.id}`);
    const self = me();
    const mine = self.pn ?? self.lid;
    if (!mine) return;
    const event: GroupMembershipEvent = { chatId: meta.id, recipientIds: [mine] };
    const author = await authorId(meta.author, meta.authorPn, phoneForLid);
    if (author) event.author = author;
    log(`[baileys][groups] added to a new group ${meta.id} ${JSON.stringify(meta.subject ?? "")} by ${author ?? "?"}`);
    handJoin(event, true);
  }

  async function receivePollVote(m: WAMessage): Promise<void> {
    const key = m?.key ?? {};
    if (!firstSighting(`${key.remoteJid ?? "?"}|${key.id ?? "?"}`)) {
      stats.duplicates++;
      return;
    }
    const mapped = await mapPollVote(m, {
      pollMessage,
      self: () => {
        const u = currentUser();
        return { pn: u?.id ?? null, lid: u?.lid ?? null };
      },
      ownJidFor: (chat) => ownJidFor(currentUser(), chat),
      phoneForLid,
    });
    if (mapped.kind === "forward") {
      stats.pollVotesForwarded++;
      log(
        `[baileys][poll] vote from ${mapped.payload.voter} on ${mapped.payload.parentMessage?.id?._serialized} ` +
          `options=[${(mapped.payload.selectedOptions ?? []).map((o) => o.name).join(", ")}] ${describeVia(mapped.via)}`,
      );
      hand(pollHandlers, mapped.payload, "onPollVote");
    } else if (mapped.kind === "undecryptable") {
      stats.pollVotesUndecryptable++;
      error(
        `CRITICAL: [baileys][poll] a vote on poll ${mapped.pollId} could not be read: ${mapped.reason}. ` +
          "It is not counted; MoM for that poll falls back to app voting. " +
          `Occurrence #${stats.pollVotesUndecryptable}.`,
      );
    }
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
    stats.sinceOpen[upsertType] = (stats.sinceOpen[upsertType] ?? 0) + 1;
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
    // A poll vote is not a chat message: it is decrypted and handed to
    // onPollVote, and never reaches the analyzer.
    if (pollUpdateOf(m)) {
      log(`${line} poll vote`);
      await receivePollVote(m);
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
    // Remembered BEFORE it is handed up, and whatever the upsert type
    // was: if WhatsApp does replay an offline gap, this is where the
    // restart catch-up finds it. Keyed on the view's own `from`, which is
    // the spelling `index.ts` passes back in (baileys/replay.ts).
    if (mapped.isGroup) replay.remember(view.from, view as InboundMessage);
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

    // Group events on one chain, in order: a create and the add that may
    // follow it must be seen in the order WhatsApp sent them.
    let groupChain: Promise<void> = Promise.resolve();
    const onGroupChain = (what: string, work: () => Promise<void>) => {
      groupChain = groupChain
        .then(work)
        .catch((err) => error(`[baileys][groups] ${what} failed: ${errorText(err)}`));
    };
    conn.on("group-participants.update", (update) =>
      onGroupChain("group-participants.update", () => receiveParticipants(update as ParticipantsUpdateLike)),
    );
    conn.on("groups.upsert", (metas) =>
      onGroupChain("groups.upsert", async () => {
        for (const meta of Array.isArray(metas) ? metas : []) await receiveGroupUpsert(meta as GroupMetaLike);
      }),
    );
    conn.on("groups.update", (partials) => {
      for (const p of Array.isArray(partials) ? partials : []) {
        groupCache.applyGroupUpdate(p as Partial<GroupMetaLike> & { id?: string | null });
      }
    });

    // Registered here, at construction, so it runs before any handler
    // index.ts adds: every read after this open belongs to the new epoch.
    conn.onOpen(() => {
      epoch++;
      lastOpenAt = now();
      // The §2.15 measurement is "what arrived after THIS open", so the
      // tally starts again here. The process total in `upserts` does not.
      for (const k of Object.keys(stats.sinceOpen)) delete stats.sinceOpen[k];
    });
    conn.onClose(() => deps.flushState?.());
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
      deps.flushState?.();
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

    onPollVote(handler) {
      requireConnection("onPollVote");
      pollHandlers.push(handler);
    },

    onGroupJoin(handler) {
      requireConnection("onGroupJoin");
      joinHandlers.push(handler);
    },

    onGroupLeave(handler) {
      requireConnection("onGroupLeave");
      leaveHandlers.push(handler);
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

    async sendPoll(chatId, question, options, allowMultipleAnswers) {
      // Pinned: votes are decrypted against this message for a day and a
      // half after kickoff (§2.12). And archived on disk, so a restart in
      // that window does not cost the votes still to come.
      const chat = wireChatJid(chatId);
      const result = await send(chat, pollContent(question, options, allowMultipleAnswers), undefined, true);
      const sent = result?.message?.message;
      const id = result?.key?.id;
      if (sent && id) {
        try {
          pollArchive.remember(id, chat, encodePollMessage(sent));
        } catch (err) {
          error(`[baileys][poll] could not archive poll ${id}: ${errorText(err)}`);
        }
      }
      return result;
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
      // MAY THROW, and must: the throw records group-enumeration degraded.
      const sock = getSocket();
      if (!sock) throw new NotConnectedError("no group list was read");
      const cached = groupCache.listing();
      if (cached) {
        stats.listingsFromCache++;
        const age = Math.round((groupCache.listingAgeMs() ?? 0) / 1000);
        log(`[baileys][groups] group list served from cache (read ${age}s ago; re-read after 15 min)`);
        return cached;
      }
      if (!sock.groupFetchAllParticipating) {
        throw new Error("[baileys driver] listGroups: this socket has no groupFetchAllParticipating");
      }
      const all = Object.values((await sock.groupFetchAllParticipating()) ?? {});
      groupCache.putListing(all);
      stats.listings++;
      // Whatever pairs the listing does carry are genuine. It is never
      // used as a roster: Baileys marks its LID/PN parsing as a TODO.
      for (const g of all) await seedFrom(g.participants ?? [], `listing of ${g.id}`);
      return groupCache.listing() ?? all.map((g) => ({ id: g.id, name: g.subject ?? "" }));
    },

    async groupParticipants(groupId) {
      // MAY THROW, and must: the throw records participant-sync degraded.
      // Phone form wherever a phone is known, so index.ts's sweep posts
      // phones; a LID nobody can resolve stays a LID, never its digits.
      const meta = await readRoster(groupId, "groupParticipants");
      const out: string[] = [];
      for (const p of meta.participants ?? []) {
        const id = handedUpId(p, await resolveParticipantPhone(p, phoneForLid));
        if (id) out.push(id);
      }
      return out;
    },

    async groupSnapshot(groupId, selfIds) {
      // Total: whatever fails goes into notes, as the contract says.
      try {
        const meta = await readRoster(groupId, "groupSnapshot");
        return await snapshotFromMetadata(meta, selfIds.length ? selfIds : [...selfLegacy()], {
          phoneForLid,
          pushnameFor: (ids) => {
            for (const id of ids) {
              const n = contacts.namesFor(id);
              if (n.pushname || n.name) return n.pushname ?? n.name;
            }
            return undefined;
          },
        });
      } catch (err) {
        return {
          subject: groupCache.subject(groupId),
          participants: [],
          source: "none",
          notes: [`groupMetadata failed: ${errorText(err)}`],
        };
      }
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
    /**
     * The restart catch-up, served from what the socket actually
     * delivered (`baileys/replay.ts`).
     *
     * ── This is the version that works IF the replay happens ────────
     * whatsapp-web.js answered this out of the browser's own message
     * store. Baileys keeps no store, but it is a real linked device, so
     * the theory is that WhatsApp buffers an offline gap and delivers it
     * on reconnect, which would mean the catch-up can simply read what
     * has already arrived. Nobody has measured that (§2.15), and this
     * member does not pretend otherwise: it hands back what came in,
     * says how much that was, and says in the same line what to conclude
     * if the answer is nothing.
     *
     * It does NOT throw when it has nothing. Throwing would record
     * `message-recovery` degraded on every quiet restart, which on a club
     * that plays once a week is most of them, and a CRITICAL line that
     * cries wolf every deploy is how a log stops being read. The honest
     * signal is the number, and the numbers travel: `historyServed`,
     * `historyEmpty` and `sinceOpen` are all on `stats()`.
     *
     * If the shadow run shows the replay does not happen, the rebuild is
     * `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)`,
     * which in rc14 returns a request id and delivers asynchronously on
     * `messaging-history.set` with `syncType = ON_DEMAND` and
     * `peerDataRequestSessionId` set to that id. See Phase 5 in the plan.
     */
    async fetchRecentGroupMessages(groupId, limit) {
      // Wait out the rest of the window after an open before answering,
      // so this does not race the very delivery it exists to collect.
      const elapsed = now() - lastOpenAt;
      const remaining = Math.max(0, settleMs - elapsed);
      if (remaining > 0) {
        log(
          `[baileys][history] ${groupId}: the line opened ${Math.round(elapsed / 1000)}s ago, ` +
            `waiting ${Math.round(remaining / 1000)}s for anything WhatsApp replays before ` +
            "answering the catch-up",
        );
        await wait(remaining);
      }

      const held = replay.count(groupId);
      const out = replay.recent(groupId, limit);
      stats.historyRequests++;
      stats.historyServed += out.length;
      if (out.length === 0) stats.historyEmpty++;
      log(
        `[baileys][history] ${groupId}: served ${out.length} of the last ${limit} from the ` +
          `live buffer (holding ${held}) | since this open: ${describeUpserts(stats.sinceOpen)} | ` +
          `${HISTORY_OPEN_QUESTION}`,
      );
      return out;
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
      // Memory first; a poll sent before a restart comes back from disk.
      return store.get(key) ?? (key?.id ? decodePollMessage(pollArchive.get(key.id)) ?? undefined : undefined);
    },

    async cachedGroupMetadata(jid) {
      return groupCache.forSend(jid, epoch) as GroupMetadata | undefined;
    },

    stats() {
      return { ...stats, upserts: { ...stats.upserts }, sinceOpen: { ...stats.sinceOpen } };
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
 * Harvested names and LID-to-phone pairs (`baileys/contacts.ts`), so a
 * restart no longer forgets who everyone is. Beside the keys for the same
 * reasons as the ledger: `0700`, never deleted, moved aside as a unit on a
 * re-pair. Written `0600`, at most once a minute, and on every close.
 */
const CONTACTS_FILE = "matchtime-contacts.json";
const CONTACTS_SAVE_DELAY_MS = 60_000;

/** Polls we sent, so votes after a restart can still be decrypted. */
const POLLS_FILE = "matchtime-polls.json";

/**
 * Build the real Baileys driver. Reachable only through `driver-select.ts`
 * with `WA_SHADOW=1` or `WA_BAILEYS_LIVE=1`. Building it opens nothing;
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
  // getMessage and cachedGroupMetadata; assigned straight after.
  let driver: BaileysDriver | null = null;

  // A missing file (first run, or before the folder exists) reads as empty.
  const contactsIO = jsonFileIO(join(config.authDir, CONTACTS_FILE));
  let contactsWriter: DebouncedWriter | null = null;
  const contacts = createContactDirectory(undefined, { onChange: () => contactsWriter?.markDirty() });
  contacts.importState(contactsIO.load());
  contactsWriter = createDebouncedWriter(() => contactsIO.save(contacts.exportState()), {
    delayMs: CONTACTS_SAVE_DELAY_MS,
  });
  const pollArchive = createPollArchive({ io: jsonFileIO(join(config.authDir, POLLS_FILE)) });

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
        // Ours, because Baileys ships none: without it every group send
        // costs a groupMetadata round trip. Answers only for a roster read
        // in the current connection (see the header).
        cachedGroupMetadata: (jid) => driver?.cachedGroupMetadata(jid) ?? Promise.resolve(undefined),
      });
      sock.ev.on("creds.update", () => void saveCreds());
      return sock as unknown as BaileysSocketLike;
    },
    pairPhone: config.pairPhone,
    ledger: createSessionLedger(fileLedgerIO(join(config.authDir, LEDGER_FILE))),
    printQr: (qr) => qrcode.generate(qr, { small: true }),
  });

  driver = makeBaileysDriver({
    connection,
    contacts,
    pollArchive,
    flushState: () => contactsWriter?.flush(),
  });
  return driver;
}
