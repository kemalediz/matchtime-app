/**
 * Smart-analysis glue: buffers EVERY message from a monitored group,
 * flushes the buffer to the server-side analyzer on a timer (every
 * ~10 min), and executes the returned verdicts (react, reply).
 *
 * Why batch instead of inline:
 *   - One Claude call per tick instead of per message → cheaper.
 *   - Claude sees several messages at once → can collapse state
 *     ("in if back holds up" followed 3 min later by "actually out"
 *     resolves to just OUT).
 *   - Duplicate questions in the same batch ("do we have enough?"
 *     asked by two people) get a single reply.
 *
 * Urgency rule: if the next match kicks off in less than an hour, any
 * new message triggers an immediate flush instead of waiting for the
 * next tick — we don't want slow answers to "can I still join?" at
 * kickoff-0:30.
 */
import type { Client, Message } from "whatsapp-web.js";
import {
  postAnalyzeFull,
  postHeartbeat,
  type AnalyzeInboundHistory,
  type AnalyzeInboundMessage,
  type AnalyzeResult,
} from "./api.js";
import {
  buildHeartbeat,
  emptyCounters,
  isUnattributable,
  type BotCounters,
} from "./heartbeat.js";
import { enrichOrDegrade, planFlushRetry, type InboundEnrichment } from "./inbound-enrich.js";
import { rewriteMentions, type MentionName, type RawMentionContact } from "./mentions.js";
import { firstUsableName, readMessageBody, readNotifyName, safeRead } from "./wa-read.js";
import { degradedMessage } from "./degraded.js";
import {
  missingMessageIdMessage,
  resolveWaMessageId,
  shouldLogSyntheticId,
} from "./message-id.js";
import { describeReactionFailure, planReaction, reactWithId } from "./react-with-id.js";

const HISTORY_PER_GROUP = 15;
// Ten-minute batches are the cost control: the system prompt and the
// match context are 1h-cached, so a batch bills fresh tokens only for
// the new messages and the reply it writes.
//
// There is NO regex fast path in front of this. The one in handlers.ts
// that reacted instantly to obvious IN/OUT/score was deleted on
// 2026-04-21 — deliberately, trading a few minutes of latency for a
// single code path that handles nuance end to end — so every message a
// monitored group posts is queued here and every flush is a real LLM
// call.
//
// Cost, corrected 2026-09-01. The "~£2/month at Sutton's volume" that
// stood here was one to two orders of magnitude low. It predated both
// the shadow analyzer (a second, entirely uncached analysis on every
// batch) and the prompt-cache buster, and it assumed the fast path
// above, which had already been deleted when it was written.
// analyzer-redesign-2026-08-31.md §8.4 models $58-$207 per club per
// month at 40-144 batches/day, falling to $28-$101 once step 0's two
// bugs are fixed. All of that is MODELLED, not measured: the real
// number can be read out of the database (`AnalyzedMessage` for batch
// volume, `WindowVerdict.costUsd` for a per-call price) and nobody has
// run that query yet. Do not quote a figure from this comment as an
// observation.
const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const URGENCY_WINDOW_MS = 60 * 60 * 1000; // within 1h of kickoff → flush immediately

// ─── Immediate-flush decision (pure, unit-tested) ───────────────────
/**
 * Decide whether a freshly-enqueued message should trigger an immediate
 * flush of its group's buffer instead of waiting for the next 10-min
 * tick — and, if so, why. Pure function so the precedence is testable
 * in isolation.
 *
 * Precedence (highest first):
 *   1. "mention"  — the bot was @-mentioned; a tagged command/question
 *                   should reply within seconds, not after a 10-min wait.
 *   2. "urgency"  — kickoff is within `urgencyWindowMs` from now.
 *   3. "full"     — the buffer has reached its cap.
 *   4. null       — leave it on the 10-min batch (bare In/Out, banter).
 */
export function immediateFlushReason(args: {
  botMentioned: boolean;
  bufferLen: number;
  maxBufferLen: number;
  kickoffMs: number | null;
  nowMs: number;
  urgencyWindowMs: number;
}): "mention" | "urgency" | "full" | null {
  const { botMentioned, bufferLen, maxBufferLen, kickoffMs, nowMs, urgencyWindowMs } = args;
  if (botMentioned) return "mention";
  if (typeof kickoffMs === "number" && kickoffMs - nowMs <= urgencyWindowMs) return "urgency";
  if (bufferLen >= maxBufferLen) return "full";
  return null;
}

// ─── Self-mention detection ─────────────────────────────────────────
// `isSelfMention` and `MentionedContact` are DELETED (2026-09-08),
// replaced by `contactIsBot` / `RawMentionContact` in `mentions.ts`.
// They were separate from the body rewrite, which meant two functions
// deciding "is this mention the bot?" — and the rewrite had to answer it
// anyway in order to substitute "@Match Time". Now `rewriteMentions`
// returns `botMentioned` alongside the body and `contactIsBot` is the
// single rule. All seven @lid-vs-@c.us regression cases moved with it,
// to `mentions.test.ts`, where they run through `rewriteMentions` — the
// function this file actually calls.

interface Pending {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED so the onboarding admin parser can resolve them. */
  mentions?: string[];
  /** Per-JID display names from the contact lookup. UNVERIFIED — the
   *  server checks each against the org roster before any of it becomes
   *  text (see `mentions.ts`). */
  mentionNames?: MentionName[];
  /** Did this message @-mention the bot's own JID? Computed here on the Pi
   *  (only the Pi knows its selfId); forwarded as the PRIMARY signal for
   *  the server's @Match Time interaction-contract gate. */
  botMentioned?: boolean;
  // Deliberately NO `msg: Message` here any more.
  //
  // It existed so the flush could call `target.react(emoji)` later. That is
  // exactly the bug: `Message.react()` re-reads `this.id._serialized`, which
  // the live WhatsApp Web build made unreadable, and then silently resolves
  // without placing anything. The flush now reacts through `waMessageId`
  // above — the same id it POSTs to the analyzer — via react-with-id.ts.
  // Dropping the reference keeps the two from drifting apart again, and
  // stops a buffered batch pinning wweb.js Message objects for a whole
  // flush interval.
  /** How many analyze POSTs have already failed for this message. */
  attempts: number;
}

// How many times a batch may fail its analyze POST before we give up on it.
// 1 initial attempt + 2 retries. Bounded so a genuinely poisonous payload
// can't wedge a group's buffer forever.
const MAX_FLUSH_ATTEMPTS = 3;

// ─── Inbound counters (diagnostics AND the off-Pi health signal) ─────
/**
 * Per-process tallies of what the inbound path did with the messages it was
 * handed. These exist because the 2026-08-30 outage was INVISIBLE: `[msg]`
 * lines scrolled past all day while `enqueueForAnalysis` dropped every one
 * of them before the buffer, and `flushGroup` returned on an empty buffer
 * without logging. `seen` far exceeding `buffered` is the signature of that
 * class of failure.
 *
 * They used to be printed on every empty flush and NOTHING ELSE — into
 * `bot.log`, on a Pi, which the 2026-08-30 audit named as the single
 * biggest problem in the whole incident. Since 2026-09-09 they also leave
 * the building via `reportHealth` → `POST /api/whatsapp/heartbeat`, where
 * `src/lib/bot-health.ts` decides whether a human is told. The shape lives
 * in `heartbeat.ts` so the Pi and the server cannot drift apart about what
 * each number means.
 */
const inboundStats: BotCounters = emptyCounters();

/**
 * When this bot process started. Sent with every heartbeat because the
 * counters above are per-PROCESS: without it, a server reading `synthetic=0`
 * cannot tell "the fix worked" from "it restarted a minute ago".
 */
const processStartedAt = new Date();

/**
 * Capabilities this process has declared degraded, as a SET.
 *
 * Populated by the call sites that already log a `degradedMessage(...)`
 * CRITICAL. Recording them here is what carries that sentence off the Pi:
 * the participant sweep has been dead since 2026-07-07 and said so in
 * `bot.log` every single startup, to nobody.
 *
 * Never cleared while the process lives. A capability that failed once and
 * then appeared to work is still a capability that failed, and clearing it
 * would let an intermittent fault hide between heartbeats.
 */
const degradedCapabilities = new Set<string>();

/**
 * Record that a capability is unavailable, for the next heartbeat.
 *
 * Deliberately separate from `degradedMessage()`, which composes the log
 * line: one of them is for a human reading the journal, the other is for
 * the server. Coupling them would mean any caller that logs its own
 * sentence silently stops being visible off-Pi.
 */
export function recordDegradedCapability(capability: string): void {
  if (typeof capability === "string" && capability.trim().length > 0) {
    degradedCapabilities.add(capability.trim());
  }
}

function formatInboundStats(s: BotCounters): string {
  return (
    `seen=${s.seen} buffered=${s.buffered} synthetic=${s.synthetic} ` +
    `reconstructed=${s.reconstructed} notGroup=${s.notGroup} ` +
    `nameless=${s.nameless} degradedEnrichment=${s.degradedEnrichment} ` +
    `reactFailures=${s.reactFailures} flushFailures=${s.flushFailures} ` +
    `dropped=${s.droppedMessages}`
  );
}

/**
 * Send one health report per monitored group.
 *
 * Called from the batch-flush timer on EVERY tick, including the tick where
 * every buffer was empty. That unconditionality is the entire design:
 * `flushGroup` returns early on an empty buffer and never POSTs to analyze,
 * so anything piggybacked on THAT call would have been silent for exactly
 * the three days in August when every message was being dropped before the
 * buffer. See `src/app/api/whatsapp/heartbeat/route.ts` for the full
 * transport argument.
 *
 * TOTAL. A failure to report health must never be able to disturb message
 * delivery — `postHeartbeat` already swallows its own errors, and this
 * catches anything left (a throwing `buildHeartbeat`, an exotic client
 * state) so a monitoring bug cannot take the flush timer down with it.
 */
export async function reportHealth(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    try {
      await postHeartbeat(
        buildHeartbeat({
          groupId,
          counters: inboundStats,
          processStartedAt,
          degradedCapabilities: [...degradedCapabilities],
        }),
      );
    } catch (err) {
      console.warn("[heartbeat] health report failed (ignored):", err);
    }
  }
}

/** A string when the value is a usable non-blank one, else undefined. */
function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * A WhatsApp `Contact.number` reduced to bare digits, or "" when it is not
 * a usable phone.
 *
 * `Contact.number` is normally "+447700900123" but on a half-broken layer it
 * can be a placeholder ("n/a"), a throwing getter, or absent. Anything that
 * does not reduce to a plausible run of digits is discarded rather than sent
 * to the server as a phone number: a WRONG phone resolves to the WRONG
 * player, which is far worse than no phone at all (the server then has the
 * name to fall back on).
 */
function digitsOnlyPhone(v: unknown): string {
  if (typeof v !== "string") return "";
  const digits = v.replace(/\D/g, "");
  // Shortest plausible international subscriber number is ~7 digits.
  return digits.length >= 7 ? digits : "";
}

/** `msg.timestamp` in seconds, falling back to now when unreadable. */
function safeTimestampSec(msg: Message): number {
  const ts = safeRead(msg, "timestamp");
  return typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now() / 1000;
}

/** `msg.from`, or null when it is unreadable/not a string. */
function safeGroupId(msg: Message): string | null {
  const from = safeRead(msg, "from");
  return typeof from === "string" && from.length > 0 ? from : null;
}

// ─── In-memory state ────────────────────────────────────────────────
const historyByGroup = new Map<string, AnalyzeInboundHistory[]>();
const bufferByGroup = new Map<string, Pending[]>();
const nextKickoffMsByGroup = new Map<string, number | null>();
const inFlightFlush = new Set<string>(); // prevent two flushes running in parallel per group
let flushTimer: NodeJS.Timeout | null = null;
let sharedClient: Client | null = null;

// ─── History buffer ─────────────────────────────────────────────────
export function recordHistory(groupId: string, entry: AnalyzeInboundHistory) {
  const arr = historyByGroup.get(groupId) ?? [];
  arr.push(entry);
  if (arr.length > HISTORY_PER_GROUP) arr.shift();
  historyByGroup.set(groupId, arr);
}

function getHistory(groupId: string): AnalyzeInboundHistory[] {
  return historyByGroup.get(groupId) ?? [];
}

// ─── Phone helper ───────────────────────────────────────────────────
function phoneFromAuthor(authorId: string | undefined, fromId: string): string {
  const id = authorId ?? fromId;
  // @lid senders carry no phone — return empty string so the server
  // will try a name-based fallback. @c.us senders give a real phone.
  if (!id.endsWith("@c.us")) return "";
  return id.replace("@c.us", "").replace(/^\+/, "");
}

// ─── Enqueue ────────────────────────────────────────────────────────
/**
 * Called from the `message` event handler for every message in a
 * monitored group. Pushes the message onto the group's pending buffer
 * and either (a) triggers an urgent flush if kickoff is close, or (b)
 * flushes immediately if the buffer is full.
 */
export async function enqueueForAnalysis(client: Client, msg: Message): Promise<void> {
  sharedClient = client;
  inboundStats.seen++;

  const groupId = safeGroupId(msg);
  if (!groupId || !groupId.endsWith("@g.us")) {
    inboundStats.notGroup++;
    return;
  }

  const author = safeRead(msg, "author");
  const phone = phoneFromAuthor(typeof author === "string" ? author : undefined, groupId);

  // NEVER drop a message because the library could not give us an id.
  //
  // This line used to read `if (!waMessageId) return;`, reusing the SEND
  // path's helper (PR #11) on the INBOUND path. When whatsapp-web.js's
  // injected page code fell out of step with the live WhatsApp Web build,
  // `id._serialized` stopped being readable on inbound Messages and that
  // guard silently binned EVERY group message for three days — no error, no
  // log, no AnalyzedMessage rows, no attendance for a live customer fixture.
  //
  // The id only exists for server-side dedupe and reaction mapping, so an
  // unreadable one degrades to a deterministic synthetic id (see
  // message-id.ts). Determinism matters: /api/whatsapp/analyze dedupes on
  // waMessageId, so a stable id keeps recoverGroupMessages' 2h replay
  // idempotent, while an unstable one would register attendance twice.
  const { waMessageId, synthetic, source } = resolveWaMessageId(msg);
  if (source === "reconstructed") inboundStats.reconstructed++;
  if (synthetic) {
    inboundStats.synthetic++;
    // Loud on the first, then rate-limited — one line per message would
    // drown the log on a busy group.
    if (shouldLogSyntheticId(inboundStats.synthetic)) {
      console.error(missingMessageIdMessage(inboundStats.synthetic, waMessageId));
    }
  }

  // Everything from here to `pending` is ENRICHMENT — pushname lookup,
  // @-mention resolution, self-mention detection — and every bit of it goes
  // through whatsapp-web.js's injected page code. When WhatsApp Web ships a
  // frontend change that code throws (the minified `r: r` seen on the Pi on
  // 2026-08-28) and, before this wrapper, took the whole enqueue with it:
  // the message was never buffered, never POSTed to /api/whatsapp/analyze,
  // and attendance silently stopped being recorded for a live customer.
  //
  // Enrichment is a nice-to-have; DELIVERY IS NOT. Degrade to the raw body
  // and keep going.
  // Every read below is total (`safeRead`): on the broken build these are
  // throwing getters, and before this an unguarded `msg.body` threw straight
  // past the buffer.
  const rawMentions = safeRead(msg, "mentionedIds");
  const rawMentionedIds: string[] = Array.isArray(rawMentions) ? (rawMentions as string[]) : [];
  const rawBody = readMessageBody(msg);

  // The DEGRADED-PATH IDENTITY, built from the raw payload BEFORE any
  // injected-code call is attempted.
  //
  // This is the fix for the last hole the 2026-08-28 breakage left open.
  // PRs #11/#13 guaranteed the message reaches /api/whatsapp/analyze; they
  // did not guarantee the server could tell WHO sent it. The server resolves
  // a sender by `authorPhone` first and `authorName` second — and for an
  // `@lid` privacy sender there IS no phone, so the name is the only
  // identity there is. `authorName` came solely from `msg.getContact()`, an
  // injected-page call, so on the broken build an `@lid` player's "IN"
  // arrived with no identity at all and was binned by the server instead of
  // by the Pi. Same outcome for the customer: no attendance.
  //
  // `msg._data.notifyName` is the sender's pushname as serialised ONTO the
  // message when the event fired — plain data, no page call — so it
  // survives. index.ts's `message` handler already read it for the history
  // buffer and then threw it away; now it travels with the message.
  const fallbackIdentity: InboundEnrichment = {
    body: rawBody,
    authorName: readNotifyName(msg),
    authorPhone: phone,
    botMentioned: false,
    // No contact lookup happened yet, so there are no names to offer.
    // The server will leave every @<digits> token raw, which is the
    // honest outcome for a mention nobody could look up.
    mentionNames: [],
  };

  const enriched = await enrichOrDegrade(
    fallbackIdentity,
    () => enrichInbound(client, msg, rawBody, fallbackIdentity),
    (err) => {
      // Counted BEFORE the log, because the log is the half that has never
      // worked: this exact CRITICAL has been printing into `bot.log` on the
      // Pi since 2026-08-30 and no human has read one.
      inboundStats.degradedEnrichment++;
      console.error(
        `CRITICAL: enrichment failed for ${waMessageId} in ${groupId} — ` +
          "forwarding the RAW message to the analyzer instead (author name and " +
          "@-mention resolution lost for this message). This usually means " +
          "whatsapp-web.js's injected page code is out of step with the live " +
          "WhatsApp Web build — consider pinning WA_WEB_VERSION. Cause:",
        err instanceof Error ? err.message : err,
      );
    },
  );
  const { body, authorName, authorPhone, botMentioned, mentionNames } = enriched;

  // The audit's §3 as a number. With no phone AND no usable name the server
  // resolves nobody, writes no attendance, and returns HTTP 200 while doing
  // it — and until 2026-09-09 the message was also excluded by construction
  // from the group nudge and the admin queue built to catch exactly this.
  // Counted here, at the last point the Pi still knows both fields.
  if (isUnattributable(authorPhone, authorName)) inboundStats.nameless++;

  const pending: Pending = {
    waMessageId,
    body,
    authorPhone,
    authorName,
    // WhatsApp's own timestamp when readable; wall-clock only as a last
    // resort (the analyzer needs a parseable ISO string). NOTE: the synthetic
    // id above is hashed from the RAW timestamp read, so a message whose
    // timestamp is unreadable still hashes deterministically — the fallback
    // here never feeds the id.
    timestamp: new Date(safeTimestampSec(msg) * 1000).toISOString(),
    // Forward the RAW mention JIDs unchanged — the server-side onboarding
    // parser resolves "<digits>@c.us" → phone and "<digits>@lid" → no phone.
    // Sent even when enrichment failed, so the server can still do what it
    // can with them.
    mentions: rawMentionedIds.length > 0 ? rawMentionedIds : undefined,
    // The display names behind those JIDs, UNVERIFIED. The server checks
    // each against the org roster (`lib/pipeline/mention-names.ts`) and
    // only then does a name reach the message text. Omitted when empty so
    // the payload does not grow for the ordinary no-mention message.
    mentionNames: mentionNames.length > 0 ? mentionNames : undefined,
    botMentioned,
    attempts: 0,
  };

  const arr = bufferByGroup.get(groupId) ?? [];
  arr.push(pending);
  bufferByGroup.set(groupId, arr);
  inboundStats.buffered++;

  // Decide whether to flush immediately or leave the message on the
  // 10-min batch. A direct @Match Time mention beats everything (tagged
  // commands/questions should reply within seconds); then urgency (match
  // kicks off within URGENCY_WINDOW); then a full buffer. Bare In/Out and
  // banter return null and sit until the next tick.
  // The buffer has no live cap, so pass Infinity — the "full" branch
  // stays a tested no-op here and live batching is unchanged.
  const kickoff = nextKickoffMsByGroup.get(groupId) ?? null;
  const reason = immediateFlushReason({
    botMentioned,
    bufferLen: arr.length,
    maxBufferLen: Infinity,
    kickoffMs: kickoff,
    nowMs: Date.now(),
    urgencyWindowMs: URGENCY_WINDOW_MS,
  });
  if (reason) {
    console.log(`[smart] ${reason} flush for ${groupId} (${arr.length} pending)`);
    // flushGroup's inFlightFlush guard prevents double-running per group.
    await flushGroup(client, groupId);
  }
}

/**
 * The WhatsApp-client-dependent half of enqueue: pushname, @-mention
 * resolution, self-mention detection. Extracted so `enrichOrDegrade` can
 * contain its failures — every call in here can throw when the injected
 * page code is out of step with the live WhatsApp Web build.
 */
async function enrichInbound(
  client: Client,
  msg: Message,
  rawBody: string,
  fallback: InboundEnrichment,
): Promise<InboundEnrichment> {
  const contact = await Promise.resolve()
    .then(() => msg.getContact())
    .catch(() => null);
  // Every read off `contact` is total: on the broken build these are
  // throwing getters, and one throw here used to take the whole enrichment
  // (and, before PR #11, the whole message) with it.
  // THE RAW PAYLOAD'S NAME COMES FIRST (2026-09-09, audit recommendation #1).
  //
  // `fallback.authorName` is `msg._data.notifyName` — the sender's pushname
  // serialised ONTO the message when the event fired. Plain data, no page
  // call, so it survives whatever WhatsApp ships. The contact reads below
  // go through the injected layer and are the ones that die.
  //
  // The order used to be the other way round, and "prefer the richer
  // source" sounds right until you notice what it costs: the string the
  // server matches against the roster then CHANGES the moment the layer
  // degrades. A `UserAlias` curated against the contact's `pushname`
  // silently stops matching mid-outage, so a player who resolved fine on
  // Monday is unresolvable on Tuesday for a reason nobody can see. Taking
  // the stable field first means the identity the server sees is the SAME
  // on a healthy build and a broken one — which is the property that makes
  // the degraded path actually work rather than merely not crash.
  //
  // In practice these are the same string: `notifyName` IS the pushname.
  // The contact reads remain as the fallback for the case `_data` carries
  // no notifyName at all (older payloads, some system messages).
  const authorName = firstUsableName(
    fallback.authorName,
    asOptionalString(safeRead(contact, "pushname")),
    asOptionalString(safeRead(contact, "name")),
    asOptionalString(safeRead(contact, "verifiedName")),
  );

  // `@lid` privacy senders carry no phone in their JID, but the contact
  // record usually still knows the real number. The DM path has resolved
  // it this way since the @lid incident; the GROUP path never did, so an
  // `@lid` player who COULD have been matched by phone was left to survive
  // on a fuzzy name match. Only ever an upgrade — a JID-derived phone is
  // authoritative and is never overwritten.
  const authorPhone =
    fallback.authorPhone || digitsOnlyPhone(safeRead(contact, "number"));

  // ── @-MENTIONS: LOOK THEM UP, BUT DO NOT NAME THEM ─────────────────
  //
  // WhatsApp puts each tag in the wire body as "@<jid-digits>" (e.g.
  // "@158055467598020" for an @lid mention, "@447xxx" for @c.us). The LLM
  // cannot reason about opaque ids — Kemal's "@Izzet E is replacing
  // @Elnur Mammadov" was classified as noise because the analyzer saw
  // three lid numbers and no names — so SOMETHING has to turn them into
  // names. The question is who.
  //
  // It used to be this loop, pasting `pushname || name || shortName`
  // straight into the body. That is the 2026-09-08 defect: the pushname
  // is the mentioned person's OWN profile name, not the club's name for
  // them and not what WhatsApp showed the person who typed the message.
  // "@Shahrokh🐔 Sutton Football Club" arrived as "@DÇ" and "@David
  // David 67" as "@割::::.̸̢̤̋…"; both drops were silently lost.
  // `mentions.ts` has the full measurement.
  //
  // So the contact is still fetched — we need `isMe` for the tag signal,
  // and the display name is a useful LOOKUP KEY — but the only body
  // rewrite performed here is the bot's OWN mention, to the literal
  // "@Match Time". Everything else keeps its raw token and travels as
  // `mentionNames` for the server to check against the org roster.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mentionedIds: string[] = ((msg as any).mentionedIds ?? []) as string[];
  // Resolve each mentioned contact ONCE: `isMe` for the self-mention
  // signal, and the display name for the server-side roster lookup.
  const mentionedContacts: RawMentionContact[] = [];
  for (const jid of mentionedIds) {
    try {
      const c = await client.getContactById(jid);
      // Every read is total — on the broken build these are throwing
      // getters and one throw used to lose the whole enrichment.
      mentionedContacts.push({
        jid,
        isMe: safeRead(c, "isMe") === true,
        name:
          asOptionalString(safeRead(c, "pushname")) ??
          asOptionalString(safeRead(c, "name")) ??
          asOptionalString(safeRead(c, "shortName")),
      });
    } catch {
      /* non-fatal — the raw @<digits> token survives for this mention,
         and a jid-only entry still matches for self-mention detection. */
      mentionedContacts.push({ jid });
    }
  }

  // Did this message @-mention the bot itself? Only the Pi knows its own
  // identity, so compute the structured signal HERE and forward it — the
  // server can't match the bot's own JID inside mentions[].
  //
  // IMPORTANT: WhatsApp now encodes @-mentions as opaque "<digits>@lid"
  // JIDs, while client.info.wid is the phone-based "<digits>@c.us" form, so
  // a plain `mentionedIds.includes(selfId)` is ALWAYS false even when the
  // bot was mentioned (the @lid vs @c.us identity mismatch that dropped a
  // real admin add in prod). Detect via the resolved Contact.isMe and match
  // against EVERY known bot identity form (wid @c.us, the deprecated .me,
  // and any .lid the wweb.js build exposes) — true under ANY of them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = client.info as any;
  const botIdentities: Array<string | null | undefined> = [
    client.info?.wid?._serialized,
    info?.me?._serialized,
    info?.lid?._serialized,
    info?.wid?.lid,
    info?.lid,
  ];

  const { body, mentionNames, botMentioned } = rewriteMentions({
    body: rawBody,
    contacts: mentionedContacts,
    botIdentities,
  });

  return { body, authorName, authorPhone, botMentioned, mentionNames };
}

// ─── Flush mechanics ────────────────────────────────────────────────
async function flushGroup(client: Client, groupId: string): Promise<void> {
  if (inFlightFlush.has(groupId)) return;
  inFlightFlush.add(groupId);
  try {
    const pending = bufferByGroup.get(groupId) ?? [];
    if (pending.length === 0) {
      // Log even the do-nothing flush. Silence here is exactly what hid the
      // 2026-08-30 outage for three days: the timer fired ~111 times and
      // returned without a word, so "the pipeline is stalled" and "there was
      // simply nothing to say" looked identical in the log. One compact line
      // per 10-min tick per group makes `seen=340 buffered=0` obvious.
      console.log(`[smart] flush ${groupId}: buffer empty (${formatInboundStats(inboundStats)})`);
      return;
    }
    bufferByGroup.set(groupId, []); // clear optimistically; errors will log, but we don't want to loop

    const msgsForAnalyze: AnalyzeInboundMessage[] = pending.map((p) => ({
      waMessageId: p.waMessageId,
      body: p.body,
      authorPhone: p.authorPhone,
      authorName: p.authorName,
      timestamp: p.timestamp,
      mentions: p.mentions,
      mentionNames: p.mentionNames,
      botMentioned: p.botMentioned,
    }));
    const history = getHistory(groupId);

    let results: AnalyzeResult[] = [];
    let nextKickoffMs: number | null = null;
    try {
      const res = await postAnalyzeFull({ groupId, messages: msgsForAnalyze, history });
      results = res.results;
      nextKickoffMs = res.nextKickoffMs;
    } catch (err) {
      // The buffer was cleared optimistically above, so without this the
      // whole batch of IN/OUT messages is binned on a transient network
      // blip. Put it back (bounded, so a poison batch can't loop forever)
      // and let the next tick — or the next enqueue — retry it.
      // Both counters leave the Pi on the next heartbeat. `flushFailures`
      // is a warning sign; `droppedMessages` is a customer's IN or OUT that
      // will never be recorded, which is why the server treats any non-zero
      // value as critical.
      inboundStats.flushFailures++;
      const { requeue, dropped } = planFlushRetry(pending, MAX_FLUSH_ATTEMPTS);
      inboundStats.droppedMessages += dropped.length;
      if (requeue.length > 0) {
        bufferByGroup.set(groupId, [...requeue, ...(bufferByGroup.get(groupId) ?? [])]);
      }
      console.error(
        `[smart] analyze POST failed for ${groupId} — requeued ${requeue.length}, ` +
          `dropped ${dropped.length} after ${MAX_FLUSH_ATTEMPTS} attempts:`,
        err instanceof Error ? err.message : err,
      );
      if (dropped.length > 0) {
        console.error(
          `CRITICAL: ${dropped.length} message(s) in ${groupId} never reached the analyzer — ` +
            "attendance from them is NOT recorded: " +
            dropped.map((d) => d.waMessageId).join(", "),
        );
      }
      return;
    }

    if (typeof nextKickoffMs === "number" || nextKickoffMs === null) {
      nextKickoffMsByGroup.set(groupId, nextKickoffMs);
    }

    // Log EVERY flush, not just ones with actionable results. The 2026-08-28
    // outage was diagnosed off the absence of `[smart] flush` lines, which
    // was ambiguous: it could mean "the flush never ran" (what actually
    // happened) or "it ran and nothing was actionable". One line per flush
    // removes that ambiguity.
    const actionable = results.filter((r) => r.handledBy !== "deduped");
    console.log(
      `[smart] flush ${groupId}: sent ${msgsForAnalyze.length}, ` +
        `${actionable.length}/${results.length} actionable`,
    );

    // Execute per-message actions on the WhatsApp side.
    //
    // Reactions that could not be delivered are COUNTED rather than just
    // logged one by one: the emoji is the player's entire confirmation that
    // their "in" landed, so a batch of failures is a product incident, not
    // n unrelated warnings. See reportFailedReacts after this loop.
    let failedReacts = 0;
    /** One per failure, so the CRITICAL log can break them down by cause. */
    const failureReasons: string[] = [];
    let reactAttempts = 0;

    for (const r of results) {
      if (r.handledBy === "deduped" || r.handledBy === "error") continue;
      if (!r.react && !r.reply) continue;

      const entry = pending.find((p) => p.waMessageId === r.waMessageId);
      if (!entry) continue;

      if (r.react) {
        reactAttempts++;

        // React with the id WE resolved for this message and POSTed to the
        // analyzer — `entry.waMessageId`, threaded through from the buffer,
        // NOT re-derived here and emphatically NOT `Message.react()`.
        //
        // `Message.react()` reads `this.id._serialized`, which the live
        // WhatsApp Web build made unreadable, and its page code opens with
        // `if (!messageId) return null;`. So it RESOLVED without placing
        // anything: no emoji, no throw, so the catch below never fired and
        // reactions were silently dead for days. See react-with-id.ts.
        const plan = planReaction(entry.waMessageId, r.react);

        if (plan.action === "skip") {
          // The only skip that happens in practice is a synthetic id: one we
          // invented because the message's real id was unreadable. WhatsApp
          // never issued it, so no page lookup can resolve it. A documented
          // degradation, not a bug — but the player still got no emoji, so
          // it is counted like any other failure.
          console.error(
            `[smart] react ${r.react} skipped for ${entry.waMessageId} in ${groupId}: ` +
              `${plan.reason} — ` +
              (plan.reason === "synthetic-id"
                ? "this id was synthesised locally because the message's real WhatsApp id " +
                  "could not be read, so there is no message in the page to react to"
                : "no usable id/emoji to react with"),
          );
          failedReacts++;
          failureReasons.push(plan.reason);
        } else {
          const outcome = await reactWithId(client, plan.messageId, plan.emoji);
          if (!outcome.ok) {
            console.error(
              `[smart] react ${plan.emoji} failed for ${plan.messageId} in ${groupId}: ` +
                `${outcome.reason} — ${describeReactionFailure(outcome.reason)}` +
                (outcome.detail ? ` (${outcome.detail})` : ""),
            );
            failedReacts++;
            failureReasons.push(outcome.reason);
          }
        }
      }
      if (r.reply) {
        // Prefer client.sendMessage: `getChatById` goes through
        // `window.WWebJS.getChat`, which is precisely the injected call that
        // started throwing `r: r` on 2026-08-28 while sends still worked.
        // Keep the chat path as a fallback so nothing regresses if
        // sendMessage is the one that breaks next time.
        try {
          await client.sendMessage(groupId, r.reply);
        } catch (err) {
          console.error("[smart] reply via client.sendMessage failed, trying chat:", err);
          try {
            const chat = await client.getChatById(groupId);
            await chat.sendMessage(r.reply);
          } catch (err2) {
            console.error("[smart] reply failed:", err2);
          }
        }
      }
    }

    // Off-Pi signal for the ✅ that IS the player's confirmation. A WARNING
    // server-side, not a critical: attendance is still recorded. It matters
    // because the club reads a missing emoji as "the bot is broken", and in
    // August it was silent to BOTH the player and the log (Message.react()
    // resolved without placing anything, so nothing threw). The group
    // itself is told nothing; see reportFailedReacts.
    inboundStats.reactFailures += failedReacts;

    reportFailedReacts(groupId, failedReacts, reactAttempts, failureReasons);
  } finally {
    inFlightFlush.delete(groupId);
  }
}

/**
 * What to do when reactions could not be delivered: SHOUT, and only shout.
 *
 * The attendance write is server-side and already happened, so the
 * database looks perfectly healthy while every player in the group sees
 * the bot say nothing. The old `[smart] react failed:` line was one
 * unremarkable error among hundreds and told nobody what it cost. This
 * one names the count, the group, the breakdown by cause, and — crucially —
 * that attendance IS recorded, so whoever reads it before a fixture does
 * not go hand-editing production data. bot-health reports on this line and
 * on `inboundStats.reactFailures`, and the owner gets the alert by email,
 * so neither may change shape without the reporting side moving with it.
 *
 * ── There is deliberately NO group message here (Kemal, 2026-09-16) ──
 * Until today a failed batch also produced one text post in the group:
 * "⚠️ WhatsApp won't let me add my usual reactions right now, so here it
 * is in words: …" (react-fallback.ts, now deleted along with its
 * BOT_REACT_TEXT_FALLBACK switch and cooldown). It fired for real on
 * 2026-09-16, when the whatsapp-web.js 1.34.7 upgrade broke the hand-rolled
 * react path, in a group that had already had too many bot messages that
 * day. Kemal's ruling: never that message again. If reactions cannot be
 * placed, go silent and fix the code so they can. A bot announcing that it
 * cannot react reads as a broken bot, which is worse than a missing tick.
 * So: the failure is counted and logged, and the group hears nothing.
 *
 * Synchronous and total — nothing in here can break the flush that
 * produced it.
 */
function reportFailedReacts(
  groupId: string,
  failed: number,
  attempted: number,
  reasons: string[] = [],
): void {
  if (failed === 0) return;

  // Break the failures down by cause. "Reactions are broken" was the ONLY
  // signal available during the August outage and it was not enough: a
  // page that has gone away, a library API that moved, a message that has
  // fallen out of the cache, and our own synthetic ids all want different
  // responses. Every reason string is defined in react-with-id.ts.
  const tally = new Map<string, number>();
  for (const reason of reasons) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  const breakdown = [...tally.entries()].map(([reason, n]) => `${reason}×${n}`).join(", ");

  // Mitigation wording (2026-09-16): "upgrade whatsapp-web.js" FIRST, and
  // no WA_WEB_VERSION pin advice. Today proved a pin cannot fix a library
  // break — 1.34.6's injection was wrong for every build the archive
  // offered, and only 1.34.7 matched the live one. See
  // MDs/whatsapp-outage-2026-09-16-runbook.md.
  console.error(
    `CRITICAL: ${failed} of ${attempted} reaction(s) could not be delivered in ` +
      `${groupId}${breakdown ? ` [${breakdown}]` : ""}. The attendance IS recorded ` +
      "server-side — the players simply got no ✅/🪑 confirmation, so they will think " +
      "the bot ignored them. Unless the reason above is `synthetic-id` (a message whose " +
      "real WhatsApp id we could not read at all), this means whatsapp-web.js's injected " +
      "page code is out of step with the live WhatsApp Web build. Mitigation: upgrade " +
      "whatsapp-web.js to the release whose injection matches the live build, then " +
      "redeploy with scripts/deploy-pi.sh. See MDs/whatsapp-outage-2026-09-16-runbook.md.",
  );
}


// ─── Timer ──────────────────────────────────────────────────────────
export function startBatchFlushTimer(client: Client, groupIds: string[]): void {
  sharedClient = client;
  if (flushTimer) return; // idempotent

  flushTimer = setInterval(() => {
    for (const g of groupIds) {
      flushGroup(client, g).catch((err) => console.error("[smart] scheduled flush failed:", err));
    }
    // AFTER the flushes are dispatched, and UNCONDITIONALLY — including
    // the tick where every buffer was empty.
    //
    // This is the whole off-Pi signal, and its unconditionality is the
    // design. The failure it exists to catch (August 2026: every inbound
    // message dropped before the buffer) produces nothing but empty
    // flushes, so a report that only rode along with the analyze POST
    // would have been silent for exactly the three days it was needed.
    //
    // Not awaited and never allowed to throw: `reportHealth` is total, and
    // the flushes above are already in flight, so a slow or failing report
    // cannot delay or break a single customer message.
    void reportHealth(groupIds);
  }, FLUSH_INTERVAL_MS);

  // Also do one flush a few seconds after startup so any messages that
  // came in right before boot get processed promptly.
  setTimeout(() => {
    for (const g of groupIds) {
      flushGroup(client, g).catch(() => {
        /* logged inside */
      });
    }
    // Report at startup too, so a bot that comes up, fails its startup
    // sweep and then sits there says so within seconds rather than waiting
    // out a full flush interval. It is also the first thing that tells the
    // server this org has a heartbeat-capable Pi at all.
    void reportHealth(groupIds);
  }, 15_000);
}

/**
 * Catch-up after a (re)start: re-feed the last ~2h of each monitored
 * group's messages into the analyzer. The server dedupes on waMessageId,
 * so messages already processed are dropped BEFORE any LLM call — only
 * messages that arrived while the bot was down / reconnecting (and were
 * therefore never seen) actually get analysed. Fixes the "message lost
 * during a restart" gap (Kemal 2026-06-06: Ibrahim's "in" landed during
 * a deploy restart and was never registered). Best-effort + idempotent;
 * any per-group failure is logged and skipped.
 */
export async function recoverGroupMessages(
  client: Client,
  groupIds: string[],
  window: RecoveryWindow = resolveRecoveryWindow(process.env),
): Promise<void> {
  // `ready` is not once-only: whatsapp-web.js re-injects on every page
  // navigation and emits it again (two `ready` lines under one PID on
  // 2026-09-16). Two sweeps interleaving would feed the same messages into
  // the buffer twice; the server dedupes, but there is no reason to pay
  // for it.
  if (recoverySweepInFlight) {
    console.warn("[recover-group] a sweep is already running; this call is skipped");
    return;
  }
  recoverySweepInFlight = true;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - window.lookbackHours * 60 * 60;
    for (const gid of groupIds) {
      try {
        const msgs = await fetchRecentGroupMessages(client, gid, window.fetchLimit);
        let queued = 0;
        let oldestSec = Number.POSITIVE_INFINITY;
        for (const m of msgs) {
          const ts = m.timestamp ?? 0;
          if (ts > 0 && ts < oldestSec) oldestSec = ts;
          if (m.fromMe) continue;
          if (ts < cutoffSec) continue;
          await enqueueForAnalysis(client, m); // server dedupes on waMessageId
          queued++;
        }
        console.log(
          `[recover-group] ${gid}: fetched ${msgs.length}, re-queued ${queued} from the last ` +
            `${window.lookbackHours}h (limit ${window.fetchLimit}) for catch-up`,
        );
        // The page hands back the NEWEST `limit` messages. If that many all
        // fall inside the window, older ones inside it were never seen.
        if (msgs.length >= window.fetchLimit && oldestSec >= cutoffSec) {
          console.warn(
            `[recover-group] ${gid}: every fetched message is inside the ${window.lookbackHours}h ` +
              `window, so the window is probably truncated at ${window.fetchLimit} messages. ` +
              `Raise RECOVER_FETCH_LIMIT and restart to reach further back.`,
          );
        }
      } catch (err) {
        // This whole sweep exists to close the restart gap (Kemal 2026-06-06:
        // Ibrahim's "in" landed during a deploy restart and was never
        // registered). When it fails, that gap is silently back open — and it
        // fails on exactly the deploys where it matters most.
        recordDegradedCapability("message-recovery");
        console.error(degradedMessage("message-recovery", err, gid));
      }
    }
  } finally {
    recoverySweepInFlight = false;
  }
}

let recoverySweepInFlight = false;

/** How far back the catch-up reaches, and how many messages it may ask for. */
export interface RecoveryWindow {
  lookbackHours: number;
  fetchLimit: number;
}

const DEFAULT_LOOKBACK_HOURS = 2;
const DEFAULT_FETCH_LIMIT = 50;

/**
 * Env-driven so a one-off wide replay after an outage needs no code change:
 * `RECOVER_LOOKBACK_HOURS=24 RECOVER_FETCH_LIMIT=400` on the restart that
 * follows a multi-hour gap, then removed again. Anything unparseable or
 * non-positive falls back to the default rather than to "nothing".
 */
export function resolveRecoveryWindow(env: Record<string, string | undefined>): RecoveryWindow {
  const positive = (raw: string | undefined): number | undefined => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    lookbackHours: positive(env.RECOVER_LOOKBACK_HOURS) ?? DEFAULT_LOOKBACK_HOURS,
    fetchLimit: Math.floor(positive(env.RECOVER_FETCH_LIMIT) ?? DEFAULT_FETCH_LIMIT),
  };
}

/**
 * The group's most recent messages, WITHOUT `client.getChatById`.
 *
 * On the live WhatsApp Web build (2026-09-16, whatsapp-web.js 1.34.7)
 * `getChatById` throws the minified `r` from `getChatModel` (group
 * metadata refresh + lid migration), and so does `getChats`. The message
 * read itself, `Chat.fetchMessages`, never calls `getChatModel`: it asks
 * the page for the chat with `getAsModel: false`, the same lookup every
 * successful `sendMessage` makes. The walk only ever failed because the
 * one way it knew to get a `Chat` object was the broken one.
 *
 * `Chat`'s constructor is a plain `_patch(data)`, and `fetchMessages`
 * reads nothing off the instance but `id._serialized` and the client's
 * page, so a handle built from the group id alone is enough. The old
 * path is kept as the fallback, so a build where the bare handle fails
 * behaves exactly as before.
 */
async function fetchRecentGroupMessages(
  client: Client,
  gid: string,
  limit: number,
): Promise<Message[]> {
  try {
    // CommonJS module: the structures hang off `default` under ESM import.
    const wweb = (await import("whatsapp-web.js")) as unknown as {
      default?: Record<string, unknown>;
      Chat?: unknown;
    };
    const ChatCtor = (wweb.default?.Chat ?? wweb.Chat) as new (
      c: Client,
      data: unknown,
    ) => { fetchMessages(o: { limit: number }): Promise<Message[]> };
    if (typeof ChatCtor !== "function") throw new Error("whatsapp-web.js exports no Chat");
    const handle = new ChatCtor(client, { id: { _serialized: gid } });
    return await handle.fetchMessages({ limit });
  } catch (err) {
    console.warn(
      `[recover-group] ${gid}: fetchMessages via a bare chat handle failed ` +
        `(${err instanceof Error ? err.message : String(err)}); falling back to getChatById`,
    );
  }
  const chat = await client.getChatById(gid);
  try {
    return await chat.fetchMessages({ limit });
  } catch {
    // fetchMessages can throw for chats not yet fully loaded in the
    // headless session — fall back to the cached last message so we
    // at least catch the most recent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lm = (chat as any).lastMessage as Message | undefined;
    return lm ? [lm] : [];
  }
}

export function stopBatchFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export function _test_flushNow(groupId: string): Promise<void> {
  if (!sharedClient) return Promise.resolve();
  return flushGroup(sharedClient, groupId);
}

/** Test-only: snapshot of the inbound counters. */
export function _test_getInboundStats(): BotCounters {
  return { ...inboundStats };
}

/** Test-only: clear all module-level state between cases. */
export function _test_reset(): void {
  historyByGroup.clear();
  bufferByGroup.clear();
  nextKickoffMsByGroup.clear();
  inFlightFlush.clear();
  sharedClient = null;
  degradedCapabilities.clear();
  // Reset EVERY counter by rebuilding from the canonical shape, so a
  // counter added to `BotCounters` later cannot silently leak between test
  // cases because somebody forgot to add a line here.
  Object.assign(inboundStats, emptyCounters());
}
