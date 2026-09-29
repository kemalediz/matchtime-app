/**
 * The Pi's half of the PLATFORM CHANNEL (self-join slice 3, 2026-09-29).
 *
 * Some sends belong to no club: a sign-up code today; the connect reply,
 * the owner's approval DM, the organiser's decision DM and leaving a group
 * in later slices. They used to borrow a live club's due-posts (the
 * sign-up code rode on "the first bot-enabled org"), so muting the only
 * live club stopped sign-ups. The server now queues them as `PlatformJob`
 * rows, and this runs once per scheduler tick, BEFORE the clubs, whatever
 * their switches say (`scheduler.ts`). Server side: src/lib/platform-jobs.ts.
 *
 * ── The contract with the server ─────────────────────────────────────
 * Every job handed over is already CLAIMED (claim-on-dispatch, as
 * due-posts), so every one gets exactly one report:
 *   sent     the send resolved; the message id when the library gave one
 *   failed   the send threw or timed out. Not retried: a timed-out send may
 *            already have landed, and at-most-once is the rule that keeps
 *            a customer's phone from getting duplicates. Never "sent".
 *   release  the DM pacing held it, or this build does not know the kind.
 *            The server puts it back in the queue.
 *
 * ── Pacing ───────────────────────────────────────────────────────────
 * A DM takes the SAME one-a-minute slot as a club DM (`takeDmSlot`, owned
 * by the scheduler): WhatsApp restricted the number for 21 hours after
 * about 56 DMs in quick succession. Leaving a group is not a message and is
 * not paced.
 *
 * ── Backward compatibility ───────────────────────────────────────────
 * Against a server that predates slice 3 the endpoint 404s: `fetchJobs`
 * returns null and this does nothing. That server still sends sign-up
 * codes through due-posts, which this Pi keeps handling as before.
 */
import type { WaDriver } from "./driver.js";
import type { PlatformJob, PlatformJobReport } from "./api.js";
import { waMessageIdFrom } from "./send-result.js";
import { withTimeout } from "./with-timeout.js";

export interface PlatformPollDeps {
  driver: WaDriver;
  /** The claimed jobs, or null when the server has none to give or cannot answer. */
  fetchJobs(): Promise<PlatformJob[] | null>;
  report(r: PlatformJobReport): Promise<void>;
  /** Take the shared DM slot if it is open. False means "held". */
  takeDmSlot(label: string): boolean;
  sendTimeoutMs: number;
  log?(line: string): void;
  error?(line: string, err?: unknown): void;
}

export interface PlatformPollResult {
  sent: number;
  failed: number;
  released: number;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 400);
}

export async function runPlatformJobs(deps: PlatformPollDeps): Promise<PlatformPollResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string, e?: unknown) => console.error(l, e ?? ""));
  const out: PlatformPollResult = { sent: 0, failed: 0, released: 0 };

  const jobs = await deps.fetchJobs();
  if (!jobs || jobs.length === 0) return out;

  const report = async (r: PlatformJobReport) => {
    try {
      await deps.report(r);
    } catch (err) {
      // The job was handled; only the bookkeeping failed. The next job
      // must not pay for it.
      error(`[platform] could not report ${r.outcome} for job ${r.id}:`, err);
    }
  };

  for (const job of jobs) {
    const id = typeof job?.id === "string" ? job.id : "";
    if (!id) continue;

    if (job.kind === "dm") {
      const phone = typeof job.phone === "string" ? job.phone.trim() : "";
      const text = typeof job.text === "string" ? job.text : "";
      if (!phone || !text) {
        out.failed++;
        await report({ id, outcome: "failed", error: "malformed job: a DM with no phone or no text" });
        continue;
      }
      if (!deps.takeDmSlot(`platform DM ${id}`)) {
        out.released++;
        await report({ id, outcome: "release" });
        continue;
      }
      try {
        const sent = await withTimeout(
          deps.driver.sendDirectText(phone, text),
          deps.sendTimeoutMs,
          `platform DM ${id}`,
        );
        const waMessageId = waMessageIdFrom(sent);
        out.sent++;
        log(`[platform] DM ${id} (${job.purpose ?? "?"}) sent`);
        await report(waMessageId ? { id, outcome: "sent", waMessageId } : { id, outcome: "sent" });
      } catch (err) {
        out.failed++;
        error(`[platform] DM ${id} (${job.purpose ?? "?"}) FAILED, reported as failed:`, err);
        await report({ id, outcome: "failed", error: errorText(err) });
      }
      continue;
    }

    if (job.kind === "leave-group") {
      const groupId = typeof job.groupId === "string" ? job.groupId : "";
      if (!groupId) {
        out.failed++;
        await report({ id, outcome: "failed", error: "malformed job: a leave with no group" });
        continue;
      }
      try {
        await withTimeout(deps.driver.leaveGroup(groupId), deps.sendTimeoutMs, `leave ${groupId}`);
        out.sent++;
        log(`[platform] left group ${groupId} (job ${id})`);
        await report({ id, outcome: "sent" });
      } catch (err) {
        out.failed++;
        error(`[platform] leaving ${groupId} (job ${id}) FAILED, reported as failed:`, err);
        await report({ id, outcome: "failed", error: errorText(err) });
      }
      continue;
    }

    // The server is ahead of this build. Nothing was done, so hand it back.
    out.released++;
    log(`[platform] unknown job kind "${String((job as { kind?: unknown }).kind)}" (${id}), releasing`);
    await report({ id, outcome: "release" });
  }
  return out;
}
