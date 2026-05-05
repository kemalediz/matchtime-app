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

const HISTORY_PER_GROUP = 15;
// Ten-minute batches keep Claude cost ~£2/month at Sutton's volume
// (cache hit on system + match context, only the new messages cost
// fresh tokens). A regex fast-path in handlers.ts catches obvious
// IN/OUT/score messages BEFORE they queue here, so they react
// near-instantly without burning an LLM call. Anything ambiguous
// still waits for the 10-min batch.
const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const URGENCY_WINDOW_MS = 60 * 60 * 1000; // within 1h of kickoff → flush immediately

interface Pending {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Kept so the bot can react/reply to the exact wweb.js Message later. */
  msg: Message;
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
 * Called from the `message` event handler when the regex fast-path
 * didn't act. Pushes the message onto the group's pending buffer and
 * either (a) triggers an urgent flush if kickoff is close, or (b)
 * flushes immediately if the buffer is full.
 */
export async function enqueueForAnalysis(client: Client, msg: Message): Promise<void> {
  sharedClient = client;
  if (!msg.from.endsWith("@g.us")) return;

  const phone = phoneFromAuthor(msg.author, msg.from);
  const waMessageId = msg.id?._serialized;
  if (!waMessageId) return;

  const contact = await msg.getContact().catch(() => null);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataBody = (msg as any)._data?.body;
  const baseBody =
    typeof msg.body === "string" && msg.body.length > 0
      ? msg.body
      : typeof dataBody === "string"
        ? dataBody
        : "";
  let body = baseBody;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mentionedIds: string[] = ((msg as any).mentionedIds ?? []) as string[];
  if (mentionedIds.length > 0 && body) {
    for (const jid of mentionedIds) {
      try {
        const c = await client.getContactById(jid);
        const name = c.pushname || c.name || c.shortName || null;
        if (name && typeof name === "string") {
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
        /* non-fatal — fall back to raw @<jid> for this token */
      }
    }
  }

  const pending: Pending = {
    waMessageId,
    body,
    authorPhone: phone,
    authorName,
    timestamp: new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
    msg,
  };

  const arr = bufferByGroup.get(msg.from) ?? [];
  arr.push(pending);
  bufferByGroup.set(msg.from, arr);

  // Urgency: match kicks off within URGENCY_WINDOW → flush now so any
  // "can I still join?" style questions land in the group without a
  // 10-min wait. Otherwise the buffer just sits until the next tick.
  const kickoff = nextKickoffMsByGroup.get(msg.from);
  const urgent = typeof kickoff === "number" && kickoff - Date.now() <= URGENCY_WINDOW_MS;
  if (urgent) {
    console.log(`[smart] urgency flush for ${msg.from} (${arr.length} pending)`);
    await flushGroup(client, msg.from);
  }
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
    }));
    const history = getHistory(groupId);

    let results: AnalyzeResult[] = [];
    let nextKickoffMs: number | null = null;
    try {
      const res = await postAnalyzeFull({ groupId, messages: msgsForAnalyze, history });
      results = res.results;
      nextKickoffMs = res.nextKickoffMs;
    } catch (err) {
      console.error("[smart] analyze POST failed:", err);
      return;
    }

    if (typeof nextKickoffMs === "number" || nextKickoffMs === null) {
      nextKickoffMsByGroup.set(groupId, nextKickoffMs);
    }

    const actionable = results.filter((r) => r.handledBy !== "deduped");
    if (actionable.length > 0) {
      console.log(
        `[smart] flush ${groupId}: ${actionable.length}/${results.length} actionable`,
      );
    }

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
        try {
          const chat = await client.getChatById(groupId);
          await chat.sendMessage(r.reply);
        } catch (err) {
          console.error("[smart] reply failed:", err);
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
