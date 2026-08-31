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
import { getDuePosts, ackInstruction, releaseInstruction, type DueInstruction } from "./api.js";
import { config } from "./config.js";
import { reactAndReport } from "./react-with-id.js";
import {
  waMessageIdFrom,
  isMissingSendResult,
  missingSendResultMessage,
} from "./send-result.js";

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
              // Since claim-on-dispatch (2026-07-19) the server has
              // ALREADY written this key's dedupe row, so simply skipping
              // would drop the DM permanently. Release the claim so the
              // server re-emits it on a later tick — restoring the
              // original "not acked → comes back" behaviour.
              await releaseInstruction(instr.key).catch((e) =>
                console.error(`[rate-limit] failed to release ${instr.key}:`, e),
              );
              continue;
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

/**
 * Read the WhatsApp message id out of a `sendMessage()` result, shouting if
 * the library gave us nothing.
 *
 * 2026-08-28: `client.sendMessage()` resolves to `undefined` whenever its
 * injected page code can't build a Message model — which is what WhatsApp
 * Web's summer frontend change caused. The old direct property read threw a
 * TypeError on `msg` itself (optional chaining guards `id`, not `msg`), which
 * aborted `executeInstruction` BEFORE the ACK. The group post had already
 * been delivered; the ACK never ran, so `SentNotification.waMessageId` stayed
 * NULL and — because the instruction was already claimed on dispatch — it
 * could never be retried either.
 *
 * We ACK ANYWAY in that case. Reasoning, deliberately:
 *   - Under claim-on-dispatch the server has ALREADY written the dedupe row,
 *     so NOT acking does not cause a retry — it just leaves the row without a
 *     waMessageId and skips the per-key ACK side effects (BotJob.sentAt,
 *     BenchSlotOffer.waMessageId, tentative-followup notifiedAt).
 *   - The only way to get a retry is an explicit `release`, and releasing a
 *     send that very likely landed is exactly how the 2026-07-19 duplicate
 *     flood happened. At-most-once is the deliberate design.
 *   - A missing waMessageId costs reaction tracking on one message. A
 *     duplicate send costs customer trust. Take the former.
 */
function ackMessageId(kind: string, key: string, sent: unknown): string | undefined {
  if (isMissingSendResult(sent)) {
    console.error(missingSendResultMessage(kind, key));
    return undefined;
  }
  const id = waMessageIdFrom(sent);
  if (!id) {
    console.warn(
      `[ack] ${kind} (${key}): send result carried no usable message id — ` +
        "acking without one (reaction tracking unavailable for this message)",
    );
  }
  return id;
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
        waMessageId: ackMessageId(instr.kind, instr.key, msg),
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
        waMessageId: ackMessageId(instr.kind, instr.key, msg),
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
          waMessageId: ackMessageId(instr.kind, instr.key, msg),
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
        waMessageId: ackMessageId(instr.kind, instr.key, msg),
      });
      return;
    }

    if (instr.kind === "update-reaction") {
      // Replace the bot account's reaction on the original message.
      // Placing a reaction swaps any prior one from the same account on the
      // same message — no separate clear step.
      //
      // We already HAVE the id (`instr.waMessageId`, straight from the
      // server), so react with it directly. The old code did
      // `getMessageById(id)` and then `msg.react(emoji)`, which threw both
      // ids away: `Message.react()` re-reads `this.id._serialized`, which the
      // live WhatsApp Web build made unreadable, and then its page code does
      // `if (!messageId) return null` — resolving without placing anything.
      // Two round-trips through the injected layer to achieve a silent no-op.
      // See react-with-id.ts.
      //
      // A failure is logged with a specific reason and we still ACK, so the
      // server stops re-emitting an instruction we cannot satisfy.
      await reactAndReport(client, instr.waMessageId, instr.emoji, "update-reaction");
      await ackInstruction({
        key: instr.key,
        kind: instr.kind,
      });
      return;
    }

    // Unknown kind (server is ahead of this bot build). We definitely did
    // not send anything, and the server has already claimed the key — so
    // release it, otherwise the instruction is silently lost until this
    // bot is upgraded.
    const unknown = instr as { kind: string; key: string };
    console.warn(`Unknown instruction kind "${unknown.kind}" (${unknown.key}) — releasing claim`);
    await releaseInstruction(unknown.key);
  } catch (err) {
    // Deliberately NOT released. Delivery is at-most-once by design: a
    // send that threw may still have reached WhatsApp (e.g. a timeout
    // after the message landed), and re-emitting it risks the duplicate
    // flood this whole mechanism exists to prevent. The next scheduled
    // post covers the gap.
    console.error(`Failed to execute instruction ${instr.kind} (${instr.key}):`, err);
  }
}
