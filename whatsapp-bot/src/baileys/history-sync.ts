/**
 * A LOG-ONLY diagnostic: what does WhatsApp hand this device as history?
 *
 * ── The question ────────────────────────────────────────────────────
 * On 2026-10-07 the bot was added to an existing group and the driver saw
 * one thing, the join notice. Whether WhatsApp ALSO sent older messages
 * could not be told from the log, because the driver had no listener on
 * the event they would arrive on and printed nothing that named them.
 * This module is the reading. It decides nothing.
 *
 * ── The ways older messages can reach a linked device (Baileys 7.0.0-rc14)
 *  1. `messaging-history.set`. Our own phone sends a protocol message
 *     (HISTORY_SYNC_NOTIFICATION) pointing at an encrypted blob; Baileys
 *     downloads it and emits this event with the chats, contacts and
 *     messages inside (`Utils/process-message.js`). It fires for the sync
 *     types in `PROCESSABLE_HISTORY_TYPES` that `shouldSyncHistoryMessage`
 *     accepts. The driver leaves that option at its default, which refuses
 *     only FULL, so the event DOES fire today and nobody was listening.
 *  2. `messages.upsert` with type `append`: messages the server held while
 *     the device was offline. Already logged and remembered by the driver.
 *  3. WhatsApp's own "share recent messages with a new member" feature.
 *     The protobuf carries it (`Message.messageHistoryBundle`,
 *     `Message.messageHistoryNotice`, the `isGroupHistoryMessage` flag,
 *     stub type GROUP_MEMBER_SHARE_GROUP_HISTORY_MODE) but rc14 has NO code
 *     that reads any of it. A bundle would arrive as an ordinary
 *     `messages.upsert` and, because `getContentType` only recognises keys
 *     containing "Message", be logged as "skipped: no content type".
 *
 * So two things are printed: a summary of every `messaging-history.set`,
 * and one line for any upsert that is a history carrier of kind 1 or 3.
 *
 * ── What is never printed ───────────────────────────────────────────
 * Message text, names, and the id of any chat that is not a group (a
 * direct chat's id is a phone number). Group ids, message ids, counts,
 * timestamps and enum names only.
 *
 * ── What this must never do ─────────────────────────────────────────
 * Feed the replay buffer, hand anything to the server, or change a socket
 * option. Every function here is pure and returns strings.
 */
import { proto, type WAMessage } from "baileys";
import { toNumber } from "./inbound.js";
import { isGroupJid } from "./jid.js";

export const HISTORY_SYNC_PREFIX = "[baileys][history-sync]";

/** A sync with hundreds of groups must not bury the log (or the SD card). */
export const MAX_GROUP_LINES = 40;

/**
 * The sync types for which Baileys emits `messaging-history.set`, given the
 * driver's socket options (the default `shouldSyncHistoryMessage`, which
 * refuses FULL). Mirrors `PROCESSABLE_HISTORY_TYPES` minus FULL; the test
 * pins it against the installed package.
 */
export const SYNC_TYPES_THAT_REACH_THE_EVENT: ReadonlySet<number> = new Set([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3,
  proto.HistorySync.HistorySyncType.RECENT,
  proto.HistorySync.HistorySyncType.PUSH_NAME,
  proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
  proto.HistorySync.HistorySyncType.ON_DEMAND,
]);

/** The fields of `messaging-history.set` this module reads. */
export interface HistorySetLike {
  chats?: ReadonlyArray<{ id?: string | null }> | null;
  contacts?: ReadonlyArray<unknown> | null;
  messages?: ReadonlyArray<{
    key?: { remoteJid?: string | null } | null;
    messageTimestamp?: unknown;
  }> | null;
  isLatest?: boolean;
  progress?: number | null;
  syncType?: number | null;
  chunkOrder?: number | null;
  peerDataRequestSessionId?: string | null;
}

export interface GroupHistoryCount {
  chat: string;
  messages: number;
  /** Seconds since the epoch; null when no message carried a timestamp. */
  oldest: number | null;
  newest: number | null;
}

export interface HistorySetSummary {
  syncType: string;
  chats: number;
  contacts: number;
  messages: number;
  isLatest: boolean | null;
  progress: number | null;
  chunkOrder: number | null;
  peerDataRequestSessionId: string | null;
  /** Group chats named in `chats`, whether or not any message came with them. */
  groupChats: number;
  groupMessages: number;
  /** Messages whose chat is not a group. Counted, never listed. */
  otherMessages: number;
  /** One per group, busiest first. Includes groups listed with no messages. */
  groups: GroupHistoryCount[];
}

function enumName(names: Record<string, unknown>, value: unknown): string {
  if (value === null || value === undefined) return "none";
  const n = Number(value);
  const name = Object.keys(names).find((k) => names[k] === n);
  return name ? `${name}(${n})` : `unknown(${String(value)})`;
}

export function syncTypeName(value: unknown): string {
  // The notification's enum is the wider one (it adds NO_HISTORY and
  // MESSAGE_ACCESS_STATUS); the first seven values are the same in both.
  return enumName(proto.Message.HistorySyncType as unknown as Record<string, unknown>, value);
}

function iso(sec: number | null): string {
  if (sec === null || !(sec > 0)) return "?";
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? "?" : d.toISOString().replace(".000Z", "Z");
}

/** Counts only. Group chats are named; everything else is a number. */
export function summariseHistorySet(evt: HistorySetLike | null | undefined): HistorySetSummary {
  const chats = Array.isArray(evt?.chats) ? evt.chats : [];
  const contacts = Array.isArray(evt?.contacts) ? evt.contacts : [];
  const messages = Array.isArray(evt?.messages) ? evt.messages : [];

  const groups = new Map<string, GroupHistoryCount>();
  const groupOf = (chat: string): GroupHistoryCount => {
    let g = groups.get(chat);
    if (!g) {
      g = { chat, messages: 0, oldest: null, newest: null };
      groups.set(chat, g);
    }
    return g;
  };
  for (const c of chats) {
    const id = c?.id;
    if (typeof id === "string" && isGroupJid(id)) groupOf(id);
  }
  let groupMessages = 0;
  let otherMessages = 0;
  for (const m of messages) {
    const chat = m?.key?.remoteJid;
    if (typeof chat !== "string" || !isGroupJid(chat)) {
      otherMessages++;
      continue;
    }
    groupMessages++;
    const g = groupOf(chat);
    g.messages++;
    const ts = toNumber(m?.messageTimestamp);
    if (ts > 0) {
      if (g.oldest === null || ts < g.oldest) g.oldest = ts;
      if (g.newest === null || ts > g.newest) g.newest = ts;
    }
  }

  return {
    syncType: syncTypeName(evt?.syncType),
    chats: chats.length,
    contacts: contacts.length,
    messages: messages.length,
    isLatest: typeof evt?.isLatest === "boolean" ? evt.isLatest : null,
    progress: typeof evt?.progress === "number" ? evt.progress : null,
    chunkOrder: typeof evt?.chunkOrder === "number" ? evt.chunkOrder : null,
    peerDataRequestSessionId: evt?.peerDataRequestSessionId || null,
    groupChats: groups.size,
    groupMessages,
    otherMessages,
    groups: [...groups.values()].sort((a, b) => b.messages - a.messages || a.chat.localeCompare(b.chat)),
  };
}

/**
 * The lines for one `messaging-history.set`: a header, then one line per
 * group chat. Never throws: a diagnostic must not take the bot down.
 */
export function formatHistorySetLines(
  evt: HistorySetLike | null | undefined,
  opts: { maxGroups?: number } = {},
): string[] {
  try {
    const s = summariseHistorySet(evt);
    const max = Math.max(0, opts.maxGroups ?? MAX_GROUP_LINES);
    const lines = [
      `${HISTORY_SYNC_PREFIX} messaging-history.set syncType=${s.syncType} chats=${s.chats} ` +
        `contacts=${s.contacts} messages=${s.messages} isLatest=${s.isLatest ?? "n/a"} ` +
        `progress=${s.progress ?? "n/a"} chunkOrder=${s.chunkOrder ?? "n/a"} ` +
        `onDemandRequest=${s.peerDataRequestSessionId ?? "none"} groupChats=${s.groupChats} ` +
        `groupMessages=${s.groupMessages} otherMessages=${s.otherMessages}`,
    ];
    for (const g of s.groups.slice(0, max)) {
      lines.push(
        `${HISTORY_SYNC_PREFIX}   group ${g.chat} messages=${g.messages} ` +
          `oldest=${iso(g.oldest)} newest=${iso(g.newest)}`,
      );
    }
    if (s.groups.length > max) {
      lines.push(`${HISTORY_SYNC_PREFIX}   and ${s.groups.length - max} more group chat(s) not listed`);
    }
    return lines;
  } catch (err) {
    return [`${HISTORY_SYNC_PREFIX} messaging-history.set arrived but could not be summarised: ${String(err)}`];
  }
}

/** The one line for `messaging-history.status` (a sync finished or stalled). */
export function formatHistoryStatusLine(
  evt: { syncType?: number | null; status?: string; explicit?: boolean } | null | undefined,
): string {
  return (
    `${HISTORY_SYNC_PREFIX} messaging-history.status syncType=${syncTypeName(evt?.syncType)} ` +
    `status=${evt?.status ?? "?"} explicit=${evt?.explicit ?? "?"}`
  );
}

interface HistoryMetadataLike {
  historyReceivers?: ReadonlyArray<unknown> | null;
  oldestMessageTimestamp?: unknown;
  messageCount?: unknown;
}

function describeMetadata(meta: HistoryMetadataLike | null | undefined): string {
  if (!meta) return "no metadata";
  const count = meta.messageCount === null || meta.messageCount === undefined ? "?" : toNumber(meta.messageCount);
  const oldest = toNumber(meta.oldestMessageTimestamp);
  const receivers = Array.isArray(meta.historyReceivers) ? meta.historyReceivers.length : 0;
  // The receivers are member ids: counted, not printed.
  return `messageCount=${count} oldest=${iso(oldest > 0 ? oldest : null)} receivers=${receivers}`;
}

/** Peels the wrappers a message can arrive in, without importing Baileys' helper. */
function unwrap(message: Record<string, unknown>): Record<string, unknown> {
  let content = message;
  for (let i = 0; i < 5; i++) {
    const inner = (content.ephemeralMessage ??
      content.viewOnceMessage ??
      content.viewOnceMessageV2 ??
      content.viewOnceMessageV2Extension ??
      content.documentWithCaptionMessage ??
      content.editedMessage) as { message?: Record<string, unknown> | null } | null | undefined;
    if (!inner?.message) break;
    content = inner.message;
  }
  return content;
}

function describeProtocolMessage(p: proto.Message.IProtocolMessage): string | null {
  const T = proto.Message.ProtocolMessage.Type;
  switch (p.type) {
    case T.HISTORY_SYNC_NOTIFICATION: {
      const n = p.historySyncNotification;
      const type = n?.syncType;
      const reaches = type !== null && type !== undefined && SYNC_TYPES_THAT_REACH_THE_EVENT.has(Number(type));
      const oldest = toNumber(n?.oldestMsgInChunkTimestampSec);
      return (
        `a history sync notification syncType=${syncTypeName(type)} chunkOrder=${n?.chunkOrder ?? "n/a"} ` +
        `progress=${n?.progress ?? "n/a"} oldestInChunk=${iso(oldest > 0 ? oldest : null)} ` +
        `inline=${n?.initialHistBootstrapInlinePayload?.length ? "yes" : "no"} ` +
        `onDemandRequest=${n?.peerDataRequestSessionId || "none"} ` +
        (reaches
          ? "(Baileys processes this type: a messaging-history.set line should follow)"
          : "(Baileys does NOT process this type with our socket options: no messaging-history.set follows)")
      );
    }
    case T.PEER_DATA_OPERATION_REQUEST_MESSAGE: {
      const type = p.peerDataOperationRequestMessage?.peerDataOperationRequestType;
      return (
        "a peer data request to our own phone " +
        `type=${enumName(proto.Message.PeerDataOperationRequestType as unknown as Record<string, unknown>, type)}`
      );
    }
    case T.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: {
      const r = p.peerDataOperationRequestResponseMessage;
      const results = r?.peerDataOperationResult ?? [];
      const kinds = new Set<string>();
      for (const result of results) {
        for (const [k, v] of Object.entries(result ?? {})) {
          if (v !== null && v !== undefined && k !== "mediaUploadResult") kinds.add(k);
        }
      }
      return (
        "a peer data response from our own phone " +
        `type=${enumName(proto.Message.PeerDataOperationRequestType as unknown as Record<string, unknown>, r?.peerDataOperationRequestType)} ` +
        `results=${results.length} kinds=[${[...kinds].sort().join(", ")}]`
      );
    }
    case T.MSG_FANOUT_BACKFILL_REQUEST:
      return "a message fan-out backfill request";
    default:
      return null;
  }
}

/**
 * What an upserted message is, IF it is a way history travels; else null.
 *
 * Returns a description with counts, enum names and timestamps only. The
 * caller adds the chat and message id. Never throws.
 */
export function historyMarkerOf(msg: WAMessage | null | undefined): string | null {
  try {
    if (!msg) return null;
    const found: string[] = [];
    const info = msg as WAMessage & {
      isGroupHistoryMessage?: boolean | null;
      groupHistoryIndividualMessageInfo?: { editedAfterReceivedAsHistory?: boolean | null } | null;
      groupHistoryBundleInfo?: { processState?: number | null } | null;
    };

    if (info.messageStubType === proto.WebMessageInfo.StubType.GROUP_MEMBER_SHARE_GROUP_HISTORY_MODE) {
      // The parameters may name a member, so only their number is printed.
      found.push(
        "a group-history-sharing mode notice (stub type " +
          `${proto.WebMessageInfo.StubType.GROUP_MEMBER_SHARE_GROUP_HISTORY_MODE}, ` +
          `${info.messageStubParameters?.length ?? 0} parameter(s))`,
      );
    }
    if (info.isGroupHistoryMessage) found.push("flagged isGroupHistoryMessage");
    if (info.groupHistoryIndividualMessageInfo) {
      found.push("a message that was delivered inside a group history bundle");
    }
    if (info.groupHistoryBundleInfo) {
      found.push(
        "carries group history bundle info processState=" +
          enumName(
            proto.GroupHistoryBundleInfo.ProcessState as unknown as Record<string, unknown>,
            info.groupHistoryBundleInfo.processState,
          ),
      );
    }

    const raw = msg.message as Record<string, unknown> | null | undefined;
    if (raw) {
      const content = unwrap(raw) as proto.IMessage;
      if (content.messageHistoryBundle) {
        const b = content.messageHistoryBundle;
        found.push(
          `a group history BUNDLE (${describeMetadata(b.messageHistoryMetadata)} ` +
            `mimetype=${b.mimetype ?? "?"} downloadable=${b.directPath && b.mediaKey ? "yes" : "no"}); ` +
            "Baileys 7.0.0-rc14 does not unpack it",
        );
      }
      if (content.messageHistoryNotice) {
        found.push(
          `a group history NOTICE (${describeMetadata(content.messageHistoryNotice.messageHistoryMetadata)})`,
        );
      }
      if (content.protocolMessage) {
        const described = describeProtocolMessage(content.protocolMessage);
        if (described) found.push(described);
      }
    }
    return found.length ? found.join("; ") : null;
  } catch {
    return null;
  }
}

/**
 * The shared-history parts of an upserted message, if it carries any: the
 * bundle (the pointer to the messages) and/or the notice. Null otherwise.
 * This is what `drivers/baileys.ts` reads to capture the history shared at
 * a join (`group-history-bundle.ts`). Never throws.
 */
export function groupHistoryCarrierOf(
  msg: WAMessage | null | undefined,
): { bundle: proto.Message.IMessageHistoryBundle | null; notice: boolean } | null {
  try {
    const raw = msg?.message as Record<string, unknown> | null | undefined;
    if (!raw) return null;
    const content = unwrapAll(raw).content as proto.IMessage;
    const bundle = content.messageHistoryBundle ?? null;
    const notice = !!content.messageHistoryNotice;
    return bundle || notice ? { bundle, notice } : null;
  } catch {
    return null;
  }
}

/**
 * The full line for a history carrier seen in `messages.upsert`, or null.
 * The chat is printed only when it is a group: a history sync notification
 * travels in the chat with our own number.
 */
export function formatHistoryMarkerLine(msg: WAMessage | null | undefined, upsertType: string): string | null {
  const marker = historyMarkerOf(msg);
  if (!marker) return null;
  const chat = msg?.key?.remoteJid;
  const where = typeof chat === "string" && isGroupJid(chat) ? chat : "(not a group)";
  return `${HISTORY_SYNC_PREFIX} upsert=${upsertType} chat=${where} id=${msg?.key?.id ?? "?"} is ${marker}`;
}

// ── A message the driver could not put a type to ─────────────────────

/** The two fields WhatsApp's "send recent messages to the new member" uses. */
const BUNDLE_FIELDS = ["messageHistoryBundle", "messageHistoryNotice"] as const;

const WRAPPERS = [
  "deviceSentMessage",
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
];

/** Wrappers peeled before the field names are listed (deviceSent included). */
function unwrapAll(message: Record<string, unknown>): { content: Record<string, unknown>; wrappers: string[] } {
  const wrappers: string[] = [];
  let content = message;
  for (let i = 0; i < 6; i++) {
    const name = WRAPPERS.find((n) => (content[n] as { message?: unknown } | null | undefined)?.message);
    if (!name) break;
    wrappers.push(name);
    content = (content[name] as { message: Record<string, unknown> }).message;
  }
  return { content, wrappers };
}

function present(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/**
 * What is ON a message the driver skipped as "no content type": the names
 * of the top-level fields, never their values. For a history bundle or
 * notice, its non-secret metadata (mimetype, stated count, stated oldest
 * timestamp, how many receivers). Never a media key, a path, a URL, a
 * hash, a member id or any text. Never throws.
 */
export function describeUnreadContent(msg: WAMessage | null | undefined): string {
  try {
    const raw = msg?.message as Record<string, unknown> | null | undefined;
    const stub = (msg as { messageStubType?: unknown } | null | undefined)?.messageStubType;
    const keyPart =
      `fromMe=${msg?.key?.fromMe ? "yes" : "no"} participant=${msg?.key?.participant ? "present" : "absent"} ` +
      `stubType=${present(stub) ? String(stub) : "none"}`;
    if (!raw) return `fields=[] (no message object) ${keyPart}`;
    const { content, wrappers } = unwrapAll(raw);
    const fields = Object.keys(content)
      .filter((k) => present(content[k]))
      .sort();
    const parts = [
      `fields=[${fields.join(", ")}]`,
      `wrappers=[${wrappers.join(", ")}]`,
      `messageContextInfo=${present(content.messageContextInfo) || present(raw.messageContextInfo) ? "present" : "absent"}`,
      keyPart,
    ];
    for (const name of BUNDLE_FIELDS) {
      const node = content[name] as
        | { mimetype?: string | null; fileLength?: unknown; messageHistoryMetadata?: HistoryMetadataLike | null }
        | null
        | undefined;
      if (!node) continue;
      const length = present(node.fileLength) ? ` fileLength=${toNumber(node.fileLength)}` : "";
      const mime = name === "messageHistoryBundle" ? ` mimetype=${node.mimetype ?? "?"}` : "";
      parts.push(`${name}{${describeMetadata(node.messageHistoryMetadata)}${mime}${length}}`);
    }
    if (fields.length === 0) {
      parts.push("(decoded to an empty message: a field this Baileys' protobuf does not know, or nothing at all)");
    } else if (fields.every((f) => f === "senderKeyDistributionMessage" || f === "messageContextInfo")) {
      parts.push("(only a group encryption key hand-over or context info: no content in this message)");
    }
    return parts.join(" ");
  } catch {
    return "fields=? (could not be read)";
  }
}

export function formatUnreadContentLine(msg: WAMessage | null | undefined, upsertType: string): string {
  const chat = msg?.key?.remoteJid;
  const where = typeof chat === "string" && isGroupJid(chat) ? chat : "(not a group)";
  return (
    `${HISTORY_SYNC_PREFIX} upsert=${upsertType} chat=${where} id=${msg?.key?.id ?? "?"} ` +
    `has no content type: ${describeUnreadContent(msg)}`
  );
}

// ── Everything that reaches a group in the minutes after we are added ──

/** How long after a join a group's arrivals are tallied. */
export const JOIN_WATCH_MS = 5 * 60 * 1000;
/** A bot added to many groups at once must not grow this without bound. */
export const MAX_WATCHED_GROUPS = 20;

export interface JoinWatchNote {
  upsertType: string;
  /** The message's own timestamp, seconds since the epoch (0 if unknown). */
  sentAtSec: number;
  /** What the driver did with it: "handed up (chat)", "skipped: …", "could not be decrypted (…)". */
  outcome: string;
}

export interface JoinWatch {
  /** We were added to this group now. Idempotent while a watch is open. */
  opened(chat: string | null | undefined, joinedAtSec?: number): boolean;
  /** One arrival. Ignored unless the chat is being watched. */
  note(chat: string | null | undefined, note: JoinWatchNote): void;
  /** Summary lines for every watch whose window has passed; they are closed. */
  flush(): string[];
  watching(chat: string): boolean;
}

interface Watch {
  chat: string;
  openedAtMs: number;
  joinedAtSec: number;
  total: number;
  older: number;
  /** "age|upsertType|outcome" → count. */
  tally: Map<string, number>;
}

/**
 * Tallies, per newly joined group, every message that arrives in the
 * window by: sent before the join or not, upsert type, and what the driver
 * did with it. Counts and reasons only.
 */
export function createJoinWatch(opts: { now?: () => number; windowMs?: number; maxGroups?: number } = {}): JoinWatch {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? JOIN_WATCH_MS;
  const maxGroups = opts.maxGroups ?? MAX_WATCHED_GROUPS;
  const watches = new Map<string, Watch>();

  function summarise(w: Watch): string[] {
    const head =
      `${HISTORY_SYNC_PREFIX} after-join ${w.chat}: in the ${Math.round(windowMs / 1000)}s after we were added, ` +
      `${w.total} message(s) arrived, ${w.older} of them sent BEFORE the add`;
    const rows = [...w.tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => {
        const [age, upsertType, outcome] = k.split("|");
        return `${HISTORY_SYNC_PREFIX}   ${n} x ${age} upsert=${upsertType} ${outcome}`;
      });
    return [head, ...rows];
  }

  return {
    opened(chat, joinedAtSec) {
      if (!chat || !isGroupJid(chat)) return false;
      const existing = watches.get(chat);
      if (existing && now() - existing.openedAtMs < windowMs) return false;
      if (!existing && watches.size >= maxGroups) return false;
      watches.set(chat, {
        chat,
        openedAtMs: now(),
        joinedAtSec: joinedAtSec && joinedAtSec > 0 ? joinedAtSec : Math.floor(now() / 1000),
        total: 0,
        older: 0,
        tally: new Map(),
      });
      return true;
    },
    note(chat, note) {
      const w = chat ? watches.get(chat) : undefined;
      if (!w || now() - w.openedAtMs >= windowMs) return;
      const older = note.sentAtSec > 0 && note.sentAtSec < w.joinedAtSec;
      w.total++;
      if (older) w.older++;
      // `|` separates the parts of the key, so it may not appear in one.
      const outcome = note.outcome.replace(/\|/g, "/");
      const k = `${older ? "older-than-add" : "at-or-after-add"}|${note.upsertType}|${outcome}`;
      w.tally.set(k, (w.tally.get(k) ?? 0) + 1);
    },
    flush() {
      const lines: string[] = [];
      for (const [chat, w] of [...watches]) {
        if (now() - w.openedAtMs < windowMs) continue;
        watches.delete(chat);
        lines.push(...summarise(w));
      }
      return lines;
    },
    watching: (chat) => {
      const w = watches.get(chat);
      return !!w && now() - w.openedAtMs < windowMs;
    },
  };
}
