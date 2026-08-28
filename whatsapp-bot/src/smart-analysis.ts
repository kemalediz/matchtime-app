/**
 * Smart-analysis glue: buffers any message the regex fast-path didn't
 * handle, flushes the buffer to the server-side analyzer on a timer
 * (every ~10 min), and executes the returned verdicts (react, reply).
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
  type AnalyzeInboundHistory,
  type AnalyzeInboundMessage,
  type AnalyzeResult,
} from "./api.js";
import { enrichOrDegrade, planFlushRetry, type InboundEnrichment } from "./inbound-enrich.js";
import { waMessageIdFrom } from "./send-result.js";

const HISTORY_PER_GROUP = 15;
// Ten-minute batches keep Claude cost ~£2/month at Sutton's volume
// (cache hit on system + match context, only the new messages cost
// fresh tokens). A regex fast-path in handlers.ts catches obvious
// IN/OUT/score messages BEFORE they queue here, so they react
// near-instantly without burning an LLM call. Anything ambiguous
// still waits for the 10-min batch.
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

// ─── Self-mention detection (pure, unit-tested) ─────────────────────
/** A mentioned JID plus, when its Contact could be resolved, the
 *  whatsapp-web.js `Contact.isMe` flag. */
export interface MentionedContact {
  /** Mentioned JID as it appears in `mentionedIds` — "<digits>@c.us" or
   *  the opaque "<digits>@lid" form WhatsApp now emits for @-mentions. */
  jid: string;
  /** Resolved `Contact.isMe`; undefined when the contact couldn't be fetched. */
  isMe?: boolean;
}

/**
 * Did this message @-mention the BOT itself? Immune to the
 * @c.us-vs-@lid identity mismatch that caused the prod incident.
 *
 * Root cause: WhatsApp encodes @-mentions as opaque "<digits>@lid" JIDs,
 * but `client.info.wid` is the phone-based "<digits>@c.us" form. So a plain
 * `mentionedIds.includes(selfId)` is ALWAYS false even when the bot was
 * mentioned (the mention carries the bot's @lid identity, selfId is its
 * @c.us identity — two different strings for the same account).
 *
 * Reliable signal: the resolved `Contact.isMe` boolean, which is true for
 * the bot's own contact regardless of JID format. We also match the raw jid
 * against every known bot identity string (its @c.us wid, its @lid, etc.) as
 * belt-and-suspenders for when a contact couldn't be resolved.
 *
 * Returns true if ANY mentioned contact is the bot under ANY identity form.
 */
export function isSelfMention(
  mentioned: MentionedContact[],
  botIdentities: Array<string | null | undefined>,
): boolean {
  const botIds = new Set(botIdentities.filter((s): s is string => !!s));
  for (const m of mentioned) {
    if (m.isMe === true) return true;
    if (botIds.has(m.jid)) return true;
  }
  return false;
}

interface Pending {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED so the onboarding admin parser can resolve them. */
  mentions?: string[];
  /** Did this message @-mention the bot's own JID? Computed here on the Pi
   *  (only the Pi knows its selfId); forwarded as the PRIMARY signal for
   *  the server's @Match Time interaction-contract gate. */
  botMentioned?: boolean;
  /** Kept so the bot can react/reply to the exact wweb.js Message later. */
  msg: Message;
  /** How many analyze POSTs have already failed for this message. */
  attempts: number;
}

// How many times a batch may fail its analyze POST before we give up on it.
// 1 initial attempt + 2 retries. Bounded so a genuinely poisonous payload
// can't wedge a group's buffer forever.
const MAX_FLUSH_ATTEMPTS = 3;

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
 * Called from the `message` event handler when the regex fast-path
 * didn't act. Pushes the message onto the group's pending buffer and
 * either (a) triggers an urgent flush if kickoff is close, or (b)
 * flushes immediately if the buffer is full.
 */
export async function enqueueForAnalysis(client: Client, msg: Message): Promise<void> {
  sharedClient = client;
  if (!msg.from.endsWith("@g.us")) return;

  const phone = phoneFromAuthor(msg.author, msg.from);
  // Total read: `msg` here always IS a Message, but the same defensive
  // accessor is used everywhere else and costs nothing.
  const waMessageId = waMessageIdFrom(msg);
  if (!waMessageId) return;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMentionedIds: string[] = ((msg as any).mentionedIds ?? []) as string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDataBody = (msg as any)._data?.body;
  const rawBody =
    typeof msg.body === "string" && msg.body.length > 0
      ? msg.body
      : typeof rawDataBody === "string"
        ? rawDataBody
        : "";

  const enriched = await enrichOrDegrade(
    rawBody,
    () => enrichInbound(client, msg, rawBody),
    (err) =>
      console.error(
        `CRITICAL: enrichment failed for ${waMessageId} in ${msg.from} — ` +
          "forwarding the RAW message to the analyzer instead (author name and " +
          "@-mention resolution lost for this message). This usually means " +
          "whatsapp-web.js's injected page code is out of step with the live " +
          "WhatsApp Web build — consider pinning WA_WEB_VERSION. Cause:",
        err instanceof Error ? err.message : err,
      ),
  );
  const { body, authorName, botMentioned } = enriched;

  const pending: Pending = {
    waMessageId,
    body,
    authorPhone: phone,
    authorName,
    timestamp: new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
    // Forward the RAW mention JIDs unchanged — the server-side onboarding
    // parser resolves "<digits>@c.us" → phone and "<digits>@lid" → no phone.
    // Sent even when enrichment failed, so the server can still do what it
    // can with them.
    mentions: rawMentionedIds.length > 0 ? rawMentionedIds : undefined,
    botMentioned,
    msg,
    attempts: 0,
  };

  const arr = bufferByGroup.get(msg.from) ?? [];
  arr.push(pending);
  bufferByGroup.set(msg.from, arr);

  // Decide whether to flush immediately or leave the message on the
  // 10-min batch. A direct @Match Time mention beats everything (tagged
  // commands/questions should reply within seconds); then urgency (match
  // kicks off within URGENCY_WINDOW); then a full buffer. Bare In/Out and
  // banter return null and sit until the next tick.
  // The buffer has no live cap, so pass Infinity — the "full" branch
  // stays a tested no-op here and live batching is unchanged.
  const kickoff = nextKickoffMsByGroup.get(msg.from) ?? null;
  const reason = immediateFlushReason({
    botMentioned,
    bufferLen: arr.length,
    maxBufferLen: Infinity,
    kickoffMs: kickoff,
    nowMs: Date.now(),
    urgencyWindowMs: URGENCY_WINDOW_MS,
  });
  if (reason) {
    console.log(`[smart] ${reason} flush for ${msg.from} (${arr.length} pending)`);
    // flushGroup's inFlightFlush guard prevents double-running per group.
    await flushGroup(client, msg.from);
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
): Promise<InboundEnrichment> {
  const contact = await Promise.resolve()
    .then(() => msg.getContact())
    .catch(() => null);
  const authorName = contact?.pushname ?? contact?.name ?? null;

  // Resolve @-mentions in the body before forwarding to the analyzer.
  // WhatsApp wire-format puts each tag as "@<jid-number>" (e.g.
  // "@158055467598020" for an @lid sender, "@447xxx" for @c.us). The
  // LLM can't reason about opaque IDs — Kemal hit this when his
  // "@Izzet E is replacing @Elnur Mammadov" message got classified as
  // "noise" because the LLM saw three lid numbers and no names.
  // For each mentioned id, fetch the contact and replace the @<jid>
  // token with @<pushname-or-name>. Falls back to the raw token if
  // resolution fails.
  let body = rawBody;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mentionedIds: string[] = ((msg as any).mentionedIds ?? []) as string[];
  // Resolve each mentioned contact ONCE: we both rewrite the body @-token
  // and capture its `isMe` flag for self-mention detection below.
  const mentionedContacts: MentionedContact[] = [];
  for (const jid of mentionedIds) {
    try {
      const c = await client.getContactById(jid);
      mentionedContacts.push({ jid, isMe: c.isMe });
      const name = c.pushname || c.name || c.shortName || null;
      if (body && name && typeof name === "string") {
        // Match the @-tag using the digits portion of the JID. WA
        // puts the @-tag in the text as `@<digits>` (no @lid /
        // @c.us suffix in the visible body), so we strip the suffix
        // and escape regex metacharacters.
        const digits = jid.replace(/@.*$/, "").replace(/[+]/g, "");
        if (digits.length >= 5) {
          const re = new RegExp(`@${digits}\\b`, "g");
          body = body.replace(re, `@${name}`);
        }
      }
    } catch {
      /* non-fatal — fall back to raw @<jid> for this token, and to a
         jid-only (no isMe) entry for self-mention matching. */
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
  const botMentioned = isSelfMention(mentionedContacts, botIdentities);

  return { body, authorName, botMentioned };
}

// ─── Flush mechanics ────────────────────────────────────────────────
async function flushGroup(client: Client, groupId: string): Promise<void> {
  if (inFlightFlush.has(groupId)) return;
  inFlightFlush.add(groupId);
  try {
    const pending = bufferByGroup.get(groupId) ?? [];
    if (pending.length === 0) return;
    bufferByGroup.set(groupId, []); // clear optimistically; errors will log, but we don't want to loop

    const msgsForAnalyze: AnalyzeInboundMessage[] = pending.map((p) => ({
      waMessageId: p.waMessageId,
      body: p.body,
      authorPhone: p.authorPhone,
      authorName: p.authorName,
      timestamp: p.timestamp,
      mentions: p.mentions,
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
      const { requeue, dropped } = planFlushRetry(pending, MAX_FLUSH_ATTEMPTS);
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
    for (const r of results) {
      if (r.handledBy === "deduped" || r.handledBy === "error") continue;
      if (!r.react && !r.reply) continue;

      const target = pending.find((p) => p.waMessageId === r.waMessageId)?.msg;
      if (!target) continue;

      if (r.react) {
        try {
          await target.react(r.react);
        } catch (err) {
          console.error("[smart] react failed:", err);
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
  } finally {
    inFlightFlush.delete(groupId);
  }
}


// ─── Timer ──────────────────────────────────────────────────────────
export function startBatchFlushTimer(client: Client, groupIds: string[]): void {
  sharedClient = client;
  if (flushTimer) return; // idempotent

  flushTimer = setInterval(() => {
    for (const g of groupIds) {
      flushGroup(client, g).catch((err) => console.error("[smart] scheduled flush failed:", err));
    }
  }, FLUSH_INTERVAL_MS);

  // Also do one flush a few seconds after startup so any messages that
  // came in right before boot get processed promptly.
  setTimeout(() => {
    for (const g of groupIds) {
      flushGroup(client, g).catch(() => {
        /* logged inside */
      });
    }
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
export async function recoverGroupMessages(client: Client, groupIds: string[]): Promise<void> {
  const cutoffSec = Math.floor(Date.now() / 1000) - 2 * 60 * 60; // last 2h
  for (const gid of groupIds) {
    try {
      const chat = await client.getChatById(gid);
      let msgs: Message[] = [];
      try {
        msgs = await chat.fetchMessages({ limit: 50 });
      } catch {
        // fetchMessages can throw for chats not yet fully loaded in the
        // headless session — fall back to the cached last message so we
        // at least catch the most recent.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lm = (chat as any).lastMessage as Message | undefined;
        if (lm) msgs = [lm];
      }
      let queued = 0;
      for (const m of msgs) {
        if (m.fromMe) continue;
        if ((m.timestamp ?? 0) < cutoffSec) continue;
        await enqueueForAnalysis(client, m); // server dedupes on waMessageId
        queued++;
      }
      console.log(`[recover-group] ${gid}: re-queued ${queued} recent message(s) for catch-up`);
    } catch (err) {
      console.error(
        `[recover-group] ${gid} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
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

/** Test-only: clear all module-level state between cases. */
export function _test_reset(): void {
  historyByGroup.clear();
  bufferByGroup.clear();
  nextKickoffMsByGroup.clear();
  inFlightFlush.clear();
  sharedClient = null;
}
