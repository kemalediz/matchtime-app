/**
 * Schedule poller.
 *
 * Every 5 minutes per org we call /api/whatsapp/due-posts, receive a list
 * of instructions, and execute each one. The server decides timing,
 * content, and idempotency — this code just dispatches.
 *
 * After every successful action we POST to /api/whatsapp/ack so the server
 * writes a SentNotification row and the same instruction doesn't fire again.
 */
import pkg from "whatsapp-web.js";
import { getDuePosts, ackInstruction, type DueInstruction } from "./api.js";
import { config } from "./config.js";

const { Poll } = pkg;

type Client = InstanceType<typeof pkg.Client>;

interface Org {
  groupId: string;
  orgName: string;
}

let client: Client | null = null;
let orgs: Org[] = [];
let intervalId: ReturnType<typeof setInterval> | null = null;

// Outbound DM rate-limit. WhatsApp imposed a 21h spam restriction on
// the MatchTime account on 2026-04-30 after the bot fired ~56 survey
// DMs in quick succession. To stay under the radar going forward we
// hold to ≤ 1 DM per DM_GAP_MS window. DMs whose turn hasn't come yet
// are not acked — the server re-emits them on the next poll, and we
// release them when the gap elapses. Group messages, polls, bench
// prompts and reactions are unaffected (they fire inside an existing
// chat and don't trigger anti-spam).
const DM_GAP_MS = 60_000;
let lastDmAtMs = 0;

// Max time we'll wait for a single outbound send before giving up on it.
// 2026-06-12: a send to an invalid / not-on-WhatsApp number can hang
// indefinitely inside whatsapp-web.js (the underlying promise never
// settles). Since every outbound message is serialized behind this one
// throttle, one hung send wedges ALL groups. A timeout lets the queue
// advance past a stuck send instead of deadlocking forever.
const SEND_TIMEOUT_MS = 30_000;

// Re-entrancy guard. setInterval() fires tick() on a fixed cadence and
// does NOT wait for the previous (async) tick to finish. With the poll
// interval (30s) shorter than DM_GAP_MS (60s), ticks overlapped: while
// tick A was awaiting a slow/hung send, tick B fired, re-read the same
// due-posts, and raced the rate-limit gate on a STALE lastDmAtMs. The
// successful ticks kept bumping lastDmAtMs to "now", so the held DMs'
// "next allowed" countdown perpetually reset (the observed 31s/1s/60s
// cycle on 2026-06-12) and nothing was ever released — a ~2h deadlock.
// Serializing ticks makes the gate check + timer advance atomic again.
let tickRunning = false;

export function initScheduler(waClient: Client, orgConfigs: Org[]) {
  client = waClient;
  orgs = orgConfigs;

  // Poll cadence comes from config (env-driven). Server handles all
  // timing precision; the poll just decides "how stale can a queued
  // instruction get before it lands". Defaults to 30s — fast enough
  // that OTP DMs feel real-time without flooding the API.
  const intervalMs = config.schedulerIntervalMs;
  intervalId = setInterval(tick, intervalMs);
  // Kick off immediately so startup picks up any overdue instructions.
  tick().catch((err) => console.error("Initial scheduler tick failed:", err));

  console.log(
    `Scheduler started: polling due-posts every ${intervalMs / 1000}s for ${orgs.length} org(s)`,
  );
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function tick(): Promise<void> {
  if (!client) return;

  // 2026-06-12 deadlock fix: refuse to run a new tick while the previous
  // one is still in flight. setInterval keeps firing on its cadence even
  // if a tick is mid-await (e.g. a slow send). Overlapping ticks used to
  // race the DM rate-limit gate on a stale lastDmAtMs and reset the
  // "next allowed" countdown forever. One tick at a time = the gate
  // check and the timer advance below stay consistent.
  if (tickRunning) return;
  tickRunning = true;
  try {
    for (const org of orgs) {
      try {
        const result = await getDuePosts(org.groupId);
        if (!result || result.instructions.length === 0) continue;
        console.log(`[${org.orgName}] ${result.instructions.length} due instruction(s)`);
        for (const instr of result.instructions) {
          if (instr.kind === "dm") {
            const sinceLast = Date.now() - lastDmAtMs;
            if (sinceLast < DM_GAP_MS) {
              const remainingS = Math.ceil((DM_GAP_MS - sinceLast) / 1000);
              console.log(
                `[rate-limit] DM ${instr.key} held — ${remainingS}s until next DM allowed`,
              );
              continue; // not acked → server re-emits next tick
            }
            // Reserve the rate-limit window BEFORE the (awaited) send so a
            // slow/hung send can't be double-gated by a later instruction,
            // and so the timer only ever advances when we actually commit
            // to sending a DM — never merely on holding/deferring one.
            lastDmAtMs = Date.now();
          }
          await executeInstruction(instr, org.groupId);
        }
      } catch (err) {
        console.error(`[${org.orgName}] scheduler tick failed:`, err);
      }
    }
  } finally {
    tickRunning = false;
  }
}

// Reject if a promise hasn't settled within ms. 2026-06-12: guards the
// single serialized send queue against a send that never resolves (an
// invalid / not-on-WhatsApp number can hang forever in whatsapp-web.js),
// which would otherwise freeze ALL outbound traffic for every group.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function executeInstruction(instr: DueInstruction, groupId: string): Promise<void> {
  if (!client) return;

  try {
    if (instr.kind === "group-message") {
      // Server may pass `mentions` — an array of phone numbers (no +)
      // that should be tagged as real WhatsApp mentions. The text uses
      // @<phone> inline; whatsapp-web.js swaps those for proper tags
      // when the matching JID appears in this array.
      type GroupMessageWithMentions = typeof instr & { mentions?: string[] };
      const withMentions = instr as GroupMessageWithMentions;
      const options = withMentions.mentions?.length
        ? { mentions: withMentions.mentions.map((p) => `${p}@c.us`) }
        : undefined;
      const msg = options
        ? await client.sendMessage(groupId, instr.text, options)
        : await client.sendMessage(groupId, instr.text);
      await ackInstruction({
        key: instr.key,
        kind: instr.kind,
        matchId: instr.matchId,
        waMessageId: msg.id?._serialized,
      });
      return;
    }

    if (instr.kind === "group-poll") {
      // Poll options require a messageSecret per whatsapp-web.js types; it's
      // auto-generated by the lib when omitted, but TS insists.
      // Cast to the looser type the runtime actually accepts.
      const poll = new Poll(
        instr.question,
        instr.options,
        { allowMultipleAnswers: instr.multi ?? false } as ConstructorParameters<typeof Poll>[2],
      );
      const msg = await client.sendMessage(groupId, poll);
      await ackInstruction({
        key: instr.key,
        kind: instr.kind,
        matchId: instr.matchId,
        waMessageId: msg.id?._serialized,
      });
      return;
    }

    if (instr.kind === "dm") {
      const jid = `${instr.phone}@c.us`;
      try {
        const msg = await withTimeout(
          client.sendMessage(jid, instr.text),
          SEND_TIMEOUT_MS,
          `DM send to ${instr.phone}`,
        );
        await ackInstruction({
          key: instr.key,
          kind: instr.kind,
          matchId: instr.matchId,
          targetUser: instr.targetUser,
          waMessageId: msg.id?._serialized,
        });
      } catch (e) {
        // 2026-06-12: a failed/timed-out DM (bad number, not on WhatsApp)
        // must NOT be retried forever — left un-acked, the server re-emits
        // it every poll and it re-claims the rate-limit slot indefinitely,
        // starving every other DM. ACK it so the server records it as
        // handled and the queue advances past it. The window was already
        // reserved by the caller, so pacing is preserved.
        console.error(`DM send failed for ${instr.phone} (${instr.key}), acking to skip:`, e);
        await ackInstruction({
          key: instr.key,
          kind: instr.kind,
          matchId: instr.matchId,
          targetUser: instr.targetUser,
        });
      }
      return;
    }

    if (instr.kind === "bench-prompt") {
      // Post in the group (@mention the user via their JID).
      const mentions = [`${instr.phone}@c.us`];
      const msg = await client.sendMessage(groupId, instr.text, { mentions });
      await ackInstruction({
        key: instr.key,
        kind: instr.kind,
        matchId: instr.matchId,
        benchUserId: instr.userId,
        waMessageId: msg.id?._serialized,
      });
      return;
    }

    if (instr.kind === "update-reaction") {
      // Look up the original message and replace the bot account's
      // reaction. whatsapp-web.js's msg.react() swaps any prior react
      // from this account on the same message — no separate clear
      // step. If the message can't be found (rare; very old messages
      // can fall out of the cache) we still ACK so the server stops
      // re-emitting it.
      try {
        const msg = await client.getMessageById(instr.waMessageId);
        if (msg) {
          await msg.react(instr.emoji);
        } else {
          console.warn(`update-reaction: message not found ${instr.waMessageId}`);
        }
      } catch (e) {
        console.warn(`update-reaction failed for ${instr.waMessageId}:`, e);
      }
      await ackInstruction({
        key: instr.key,
        kind: instr.kind,
      });
      return;
    }
  } catch (err) {
    console.error(`Failed to execute instruction ${instr.kind} (${instr.key}):`, err);
  }
}
