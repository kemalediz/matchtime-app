/**
 * THE CLOUD WEBHOOK, THE I/O HALF (WhatsApp Cloud API plan, PR C5; MDs/
 * whatsapp-cloud-api-plan-2026-11-04.md sections 5.2, 5.3, 5.4 and 5.8).
 * The route (`/api/whatsapp/cloud/webhook`) is a thin adapter over this;
 * the rules are `webhook-auth.ts`, `inbound.ts` and `status-rules.ts`.
 *
 * ── ONE POST ───────────────────────────────────────────────────────────
 *   1. The signature, before anything is parsed: missing, malformed or
 *      wrong is 401 and nothing is read or written.
 *   2. CLOUD_API_ENABLED off: 200 and nothing else. No row, no pipeline,
 *      no status, no template. Behaviour is exactly what it was.
 *   3. Parse ours only: our WhatsApp account's entries (WA_CLOUD_WABA_ID
 *      when set), so Meta's test account on the same app never overwrites
 *      a template status of ours, and our number's messages and statuses
 *      (WA_CLOUD_PHONE_NUMBER_ID when set).
 *   4. Every message is written to `WaInbound` BEFORE the 200, keyed by
 *      (channel, wamid): a repeat writes nothing. One insert for the POST;
 *      if the database refuses it, row by row, so one unwritable row (a
 *      character Postgres will not store) is logged by wamid and skipped
 *      instead of sinking everyone else's messages. Only a database that
 *      cannot be reached is a 500, so Meta sends the POST again (for up to
 *      7 days), which the key makes safe. A message with no text is
 *      written already processed: it still opens his 24 hour window,
 *      which the dispatcher reads here.
 *   5. 200, then the work in `after()`: each text into THE ONE DM PIPELINE
 *      (`handleInboundDm`, channel cloud, plan 5.3), each status onto its
 *      cloud job, template updates to C6, Meta's marketing stop logged for
 *      C8 (plan 5.7: the wiring is C8's).
 *
 * ── NEVER THE SAME WAMID TWICE, AND NEVER LOST ─────────────────────────
 * A text runs only after a compare-and-set claims its row: attempts 0 to
 * 1, with `result` set to "processing since <the claim's time>". Whoever
 * loses (Meta's retry, a second POST, the sweep) runs nothing. A run
 * closes the row only while it still holds that exact claim.
 *
 * A pipeline that THROWS is recorded and not run again: its answer may
 * already be queued. A run that DIED (the function stopped after the claim,
 * or its closing write was lost) leaves the row "processing". The sweep
 * (`sweepCloudInbound`, per-minute cron) runs such a row once more when its
 * claim is older than `INBOUND_RETRY_AFTER_MS`, re-claiming it with the
 * same compare-and-set (attempts 1 to 2, on the exact claim it read). That
 * wait is over twice the `maxDuration` of both routes that can claim (the
 * webhook, whose `after()` work runs within its route's limit, and the
 * cron), so the first run has been stopped by then and cannot overlap the
 * retry; two sweeps cannot both win the re-claim. A row whose retry died
 * too is closed as failed, logged and counted. A row the work never
 * started (attempts 0) is run by the sweep after `INBOUND_SWEEP_AFTER_MS`.
 *
 * Logs keep wamids, job ids, phone numbers and Meta's codes; never the
 * text and never a secret (the 2026-10-15 rule).
 */
import { db } from "../db";
import { handleInboundDm, type InboundDm } from "../inbound-dm";
import { onPoolOfferJobFailed, onPoolOfferJobSent } from "../pool/dispatch";
import { cloudApiEnabled, type SendChannel } from "../send-channel";
import {
  inboundDmOf,
  ourEntriesOnly,
  parseCloudWebhook,
  type CloudInboundMessage,
  type CloudStatusUpdate,
  type CloudUserPreference,
  type ParsedCloudWebhook,
} from "./inbound";
import { cloudStatusUpdate, type StatusJobView } from "./status-rules";
import { applyTemplateStatusPayload } from "./template-status";
import { validMetaSignature } from "./webhook-auth";

type Env = Record<string, string | undefined>;

/** The number these messages came in on, as `WaInbound.channel` stores it. */
const OFFICIAL_NUMBER: SendChannel = "cloud";

/** The sweep leaves an unstarted row this long to the work that recorded it. */
export const INBOUND_SWEEP_AFTER_MS = 2 * 60_000;
/** Unstarted rows the sweep starts per run (the cron runs every minute). */
export const INBOUND_SWEEP_BATCH = 10;
/** A claim older than this belongs to a run that has been stopped: over
 *  twice the 300 second `maxDuration` of the webhook and cron routes
 *  (pinned by `webhook.test.ts`). */
export const INBOUND_RETRY_AFTER_MS = 15 * 60_000;
/** Runs a message may have: the first, and one retry after a dead run. */
export const INBOUND_MAX_ATTEMPTS = 2;
/** Claimed rows the sweep looks at per run. */
const INBOUND_STUCK_SCAN = 50;
/** Tries at a status's compare-and-set before giving up. */
const STATUS_TRIES = 3;

const CLAIM_PREFIX = "processing since ";
const ABANDONED = "failed: interrupted twice, not run again";
const LABEL_RE = /^[\w-]{1,64}$/;
const TAG = "[cloud-webhook]";

export interface CloudWebhookReport {
  processed: number;
  duplicates: number;
  statusesApplied: number;
  templateUpdates: number;
  preferences: CloudUserPreference[];
}

export interface CloudWebhookAcceptance {
  status: 200 | 401 | 500;
  body: Record<string, unknown>;
  /** What to run in `after()`; null when there is nothing to do. */
  work: (() => Promise<CloudWebhookReport>) | null;
}

/** Prisma's codes for a database it cannot reach (P1xxx), its pool timing
 *  out (P2024) and too many connections (P2037). */
const UNAVAILABLE_CODES = new Set(["P2024", "P2037"]);
const UNAVAILABLE_TEXT = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Can't reach database|Connection terminated/i;

/** True when the database itself is unavailable (worth Meta's resend), not
 *  when it refused one row. */
export function databaseUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "PrismaClientInitializationError" || e.name === "PrismaClientRustPanicError") return true;
  if (typeof e.code === "string" && (/^P1\d{3}$/.test(e.code) || UNAVAILABLE_CODES.has(e.code))) return true;
  return typeof e.message === "string" && UNAVAILABLE_TEXT.test(e.message);
}

class DatabaseUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super("database unavailable");
  }
}

/** Steps 1 to 4 above; the route answers with `status` and `body` and
 *  schedules `work`. */
export async function acceptCloudWebhook(args: {
  rawBody: Buffer;
  signature: string | null;
  /** The request it arrived on: the pipeline reads its test seams. */
  request: Request;
  env?: Env;
  now?: () => Date;
}): Promise<CloudWebhookAcceptance> {
  const env = args.env ?? process.env;
  const now = args.now ?? (() => new Date());
  if (!validMetaSignature(args.rawBody, args.signature, env.WA_CLOUD_APP_SECRET)) {
    console.warn(`${TAG} refused a POST: ${args.signature ? "wrong" : "no"} signature`);
    return { status: 401, body: { error: "invalid signature" }, work: null };
  }
  if (!cloudApiEnabled(env)) return { status: 200, body: { ok: true, ignored: "cloud-api-off" }, work: null };

  let raw: unknown;
  try {
    raw = JSON.parse(args.rawBody.toString("utf8"));
  } catch {
    console.error(`${TAG} a signed POST was not JSON; ignored`);
    return { status: 200, body: { ok: true, ignored: "not-json" }, work: null };
  }
  const { payload, dropped } = ourEntriesOnly(raw, env.WA_CLOUD_WABA_ID);
  if (dropped > 0) console.log(`${TAG} ${dropped} entr${dropped === 1 ? "y" : "ies"} for another WhatsApp account of the app ignored`);
  const parsed = oursOnly(parseCloudWebhook(payload), env);
  let unwritten: Set<string>;
  try {
    unwritten = await recordInbound(parsed.messages, now());
  } catch (err) {
    console.error(`${TAG} the database is unavailable; ${parsed.messages.length} message(s) not recorded, Meta will send them again: ${nameOf(err instanceof DatabaseUnavailable ? err.cause : err)}`);
    return { status: 500, body: { error: "not recorded" }, work: null };
  }
  const recorded = { ...parsed, messages: parsed.messages.filter((m) => !unwritten.has(m.wamid)) };
  return { status: 200, body: { ok: true }, work: () => processCloudWebhook(recorded, payload, args.request, now) };
}

const nameOf = (err: unknown) => (err as Error)?.name ?? "error";

/** Drop what came in on another of the app's numbers. */
function oursOnly(parsed: ParsedCloudWebhook, env: Env): ParsedCloudWebhook {
  const ours = (env.WA_CLOUD_PHONE_NUMBER_ID ?? "").trim();
  if (!ours) return parsed;
  const keep = <T extends { phoneNumberId: string | null }>(xs: T[]) => xs.filter((x) => !x.phoneNumberId || x.phoneNumberId === ours);
  const messages = keep(parsed.messages);
  const statuses = keep(parsed.statuses);
  const dropped = parsed.messages.length - messages.length + parsed.statuses.length - statuses.length;
  if (dropped > 0) console.log(`${TAG} ${dropped} update(s) for another number of the app ignored`);
  return { ...parsed, messages, statuses };
}

/** Meta's time when it is sane (never ahead of now), else now. The
 *  dispatcher reads `receivedAt` as when his window opened, so a message
 *  Meta delivers late must not open it late. */
function receivedAtOf(m: CloudInboundMessage, now: Date): Date {
  const n = Number(m.timestamp);
  if (!m.timestamp || !Number.isFinite(n) || n <= 0) return now;
  const at = new Date(n * 1000);
  return at.getTime() > now.getTime() ? now : at;
}

/** Write the POST's messages. Returns the wamids the database would not
 *  take; throws `DatabaseUnavailable` when it cannot be reached at all. */
async function recordInbound(messages: CloudInboundMessage[], now: Date): Promise<Set<string>> {
  const unwritten = new Set<string>();
  if (messages.length === 0) return unwritten;
  const rows = messages.map((m) => {
    const dm = inboundDmOf(m);
    const row = { channel: OFFICIAL_NUMBER, wamid: m.wamid, phone: m.phone, waUserId: m.waUserId, receivedAt: receivedAtOf(m, now) };
    return dm ? { ...row, payload: dm as object } : { ...row, payload: { type: m.type }, processedAt: now, result: `no text: ${m.type}`.slice(0, 64) };
  });
  const summary = messages.map((m) => `${m.wamid} from ${m.phone ?? m.waUserId} (${m.type})`).join(", ");
  try {
    const { count } = await db.waInbound.createMany({ data: rows, skipDuplicates: true });
    console.log(`${TAG} recorded ${count} of ${messages.length} message(s): ${summary}`);
    return unwritten;
  } catch (err) {
    if (databaseUnavailable(err)) throw new DatabaseUnavailable(err);
    console.warn(`${TAG} the POST's insert was refused (${nameOf(err)}); writing its ${rows.length} message(s) one by one`);
  }
  for (const row of rows) {
    try {
      await db.waInbound.createMany({ data: [row], skipDuplicates: true });
    } catch (err) {
      if (databaseUnavailable(err)) throw new DatabaseUnavailable(err);
      unwritten.add(row.wamid);
      console.error(`${TAG} ${row.wamid} from ${row.phone ?? row.waUserId}: not recorded, the database refused the row (${nameOf(err)}); skipped`);
    }
  }
  console.log(`${TAG} recorded ${rows.length - unwritten.size} of ${messages.length} message(s) one by one: ${summary}`);
  return unwritten;
}

/** Step 5: everything after the 200. Never throws. */
async function processCloudWebhook(parsed: ParsedCloudWebhook, payload: unknown, request: Request, now: () => Date): Promise<CloudWebhookReport> {
  const report: CloudWebhookReport = { processed: 0, duplicates: 0, statusesApplied: 0, templateUpdates: 0, preferences: parsed.preferences };

  for (const m of parsed.messages) {
    const dm = inboundDmOf(m);
    if (!dm) continue;
    try {
      if (await runRecorded(m.wamid, dm, request, now, { attempts: 0 })) report.processed++;
      else report.duplicates++;
    } catch (err) {
      // The claim itself failed: the row is unstarted, so the sweep runs it.
      console.error(`${TAG} ${m.wamid}: not claimed, left for the sweep: ${nameOf(err)}`);
    }
  }

  for (const st of parsed.statuses) {
    try {
      if (await applyStatus(st, now())) report.statusesApplied++;
    } catch (err) {
      console.error(`${TAG} status ${st.wamid} ${st.status} not applied: ${nameOf(err)}`);
    }
  }

  if (parsed.templateUpdates > 0) {
    try {
      // Our account's entries only (step 3): C6 reads the payload as given.
      const t = await applyTemplateStatusPayload(payload);
      report.templateUpdates = t.written;
    } catch (err) {
      console.error(`${TAG} template updates not written: ${nameOf(err)}`);
    }
  }

  // Meta's own marketing stop (plan 5.7). Wiring it to his pool profile
  // and the owner dashboard is PR C8; until then it is logged.
  for (const p of parsed.preferences) {
    console.warn(`${TAG} user_preferences ${p.category ?? "?"} ${p.value ?? "?"} phone=${p.phone ?? "-"} user=${p.waUserId ?? "-"} (for C8: not wired yet)`);
  }
  for (const f of parsed.otherFields) console.log(`${TAG} ${f} received (no reader yet)`);
  if (parsed.skipped > 0) console.warn(`${TAG} ${parsed.skipped} unreadable update(s) skipped`);
  return report;
}

const claimStamp = (at: Date) => `${CLAIM_PREFIX}${at.toISOString()}`;

/** Claim the row from the state it was read in (attempts 0 for a first
 *  run; attempts 1 and the exact claim read, for a retry), with a fresh
 *  claim stamp. Null when somebody else got there first. */
async function claim(wamid: string, from: { attempts: number; result?: string }, at: Date): Promise<string | null> {
  const stamp = claimStamp(at);
  const { count } = await db.waInbound.updateMany({
    where: { channel: OFFICIAL_NUMBER, wamid, processedAt: null, attempts: from.attempts, ...(from.result !== undefined ? { result: from.result } : {}) },
    data: { attempts: from.attempts + 1, result: stamp },
  });
  return count === 1 ? stamp : null;
}

/** Close the row, only while this run still holds its claim. Tried twice:
 *  a row left open is retried by the sweep. */
async function close(wamid: string, stamp: string, result: string, at: Date): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try {
      await db.waInbound.updateMany({ where: { channel: OFFICIAL_NUMBER, wamid, processedAt: null, result: stamp }, data: { processedAt: at, result } });
      return;
    } catch (err) {
      console.error(`${TAG} ${wamid}: marking it processed failed (try ${i + 1}): ${nameOf(err)}`);
    }
  }
}

/** Claim the row, run the one DM pipeline, record what it did. False
 *  when somebody else had already claimed it. */
async function runRecorded(wamid: string, dm: InboundDm, request: Request, now: () => Date, from: { attempts: number; result?: string }): Promise<boolean> {
  const stamp = await claim(wamid, from, now());
  if (!stamp) {
    console.log(`${TAG} ${wamid}: already taken, not run again`);
    return false;
  }
  let result: string;
  try {
    const res = await handleInboundDm(dm, { channel: OFFICIAL_NUMBER, request });
    result = `${res.status}${await labelOf(res)}`;
  } catch (err) {
    result = `error: ${nameOf(err)}`;
    console.error(`${TAG} ${wamid} from ${dm.phone ?? "-"}: the DM pipeline failed; not run again: ${nameOf(err)}`);
  }
  await close(wamid, stamp, result, now());
  console.log(`${TAG} ${wamid} from ${dm.phone ?? "-"}: ${result}${from.attempts > 0 ? " (retry)" : ""}`);
  return true;
}

/** The pipeline's own label (`handled` or `ignored`), only when it is a
 *  short token: the result column is shown on the owner page. */
async function labelOf(res: Response): Promise<string> {
  const body = (await res.clone().json().catch(() => null)) as { handled?: unknown; ignored?: unknown } | null;
  const label = body?.handled ?? body?.ignored;
  return typeof label === "string" && LABEL_RE.test(label) ? ` ${label}` : "";
}

/** One status onto its cloud job. True when something was written. The
 *  compare-and-set needs the status as read AND every column it fills
 *  still empty (`guard`); a lost race re-reads the job and decides again. */
async function applyStatus(st: CloudStatusUpdate, now: Date): Promise<boolean> {
  const price = st.pricing ? ` ${st.pricing.category ?? "?"}${st.pricing.billable === false ? " free" : ""}` : "";
  for (let i = 0; i < STATUS_TRIES; i++) {
    const job = (await db.platformJob.findFirst({
      where: { channel: OFFICIAL_NUMBER, OR: [{ waMessageId: st.wamid }, ...(st.jobId ? [{ id: st.jobId, waMessageId: null }] : [])] },
      select: { id: true, status: true, waMessageId: true, sentAt: true, deliveredAt: true, readAt: true },
    })) as StatusJobView | null;
    if (!job) {
      console.log(`${TAG} status ${st.wamid} ${st.status}: no cloud job has it${price}`);
      return false;
    }
    const write = cloudStatusUpdate(job, st, now);
    if (!write) return false;
    const { count } = await db.platformJob.updateMany({ where: { id: job.id, status: job.status, ...write.guard }, data: write.data });
    if (count !== 1) continue;
    console.log(`${TAG} status ${st.wamid} ${st.status}: job ${job.id} to ${st.recipient ?? st.recipientUserId ?? "-"}${st.errorCode ? ` code ${st.errorCode}` : ""}${price}`);
    if (write.settles === "sent") await onPoolOfferJobSent(job.id, now, job.sentAt ?? write.data.sentAt ?? now);
    if (write.settles === "failed") await onPoolOfferJobFailed(job.id, now);
    return true;
  }
  console.warn(`${TAG} status ${st.wamid} ${st.status}: lost the race ${STATUS_TRIES} times; not applied`);
  return false;
}

const readableDm = (payload: unknown): InboundDm | null => {
  const dm = payload as InboundDm | null;
  return dm && typeof dm.body === "string" && typeof dm.waMessageId === "string" ? dm : null;
};

/** A row whose payload the pipeline cannot read: claimed, then closed. */
async function closeUnreadable(wamid: string, from: { attempts: number; result?: string }, now: Date): Promise<void> {
  const stamp = await claim(wamid, from, now);
  if (stamp) await close(wamid, stamp, "unreadable payload", now);
}

/**
 * From the per-minute cron, with its request. With CLOUD_API_ENABLED off
 * it reads nothing.
 *   started    rows nobody claimed (attempts 0), older than
 *              `INBOUND_SWEEP_AFTER_MS` so the work that recorded them goes
 *              first.
 *   retried    rows still "processing" whose claim is older than
 *              `INBOUND_RETRY_AFTER_MS` (their run was stopped), run once
 *              more after re-claiming them (attempts 1 to 2).
 *   abandoned  rows whose retry was stopped too: closed as failed, logged.
 */
export async function sweepCloudInbound(opts: { request: Request; now: Date; env?: Env }): Promise<{ started: number; retried: number; abandoned: number }> {
  const out = { started: 0, retried: 0, abandoned: 0 };
  if (!cloudApiEnabled(opts.env ?? process.env)) return out;
  const now = () => opts.now;

  const unstarted = (await db.waInbound.findMany({
    where: { channel: OFFICIAL_NUMBER, processedAt: null, attempts: 0, receivedAt: { lt: new Date(opts.now.getTime() - INBOUND_SWEEP_AFTER_MS) } },
    orderBy: { receivedAt: "asc" },
    take: INBOUND_SWEEP_BATCH,
    select: { wamid: true, payload: true },
  })) as Array<{ wamid: string; payload: unknown }>;
  for (const r of unstarted) {
    const dm = readableDm(r.payload);
    if (!dm) await closeUnreadable(r.wamid, { attempts: 0 }, opts.now);
    else if (await runRecorded(r.wamid, dm, opts.request, now, { attempts: 0 })) out.started++;
  }

  const claimed = (await db.waInbound.findMany({
    where: { channel: OFFICIAL_NUMBER, processedAt: null, attempts: { gte: 1 }, result: { startsWith: CLAIM_PREFIX } },
    orderBy: { receivedAt: "asc" },
    take: INBOUND_STUCK_SCAN,
    select: { wamid: true, attempts: true, result: true, payload: true },
  })) as Array<{ wamid: string; attempts: number; result: string; payload: unknown }>;
  for (const r of claimed) {
    const claimedAt = Date.parse(r.result.slice(CLAIM_PREFIX.length));
    if (!Number.isFinite(claimedAt) || opts.now.getTime() - claimedAt < INBOUND_RETRY_AFTER_MS) continue;
    const from = { attempts: r.attempts, result: r.result };
    if (r.attempts >= INBOUND_MAX_ATTEMPTS) {
      const { count } = await db.waInbound.updateMany({
        where: { channel: OFFICIAL_NUMBER, wamid: r.wamid, processedAt: null, ...from },
        data: { processedAt: opts.now, result: ABANDONED },
      });
      if (count === 1) {
        out.abandoned++;
        console.error(`${TAG} ${r.wamid}: interrupted twice (claimed ${r.result.slice(CLAIM_PREFIX.length)}), closed as failed, not run again`);
      }
      continue;
    }
    const dm = readableDm(r.payload);
    if (!dm) await closeUnreadable(r.wamid, from, opts.now);
    else if (await runRecorded(r.wamid, dm, opts.request, now, from)) out.retried++;
  }

  if (unstarted.length + out.retried + out.abandoned > 0) {
    console.log(`${TAG} sweep: ${out.started} of ${unstarted.length} unstarted run, ${out.retried} retried, ${out.abandoned} closed as failed`);
  }
  return out;
}
