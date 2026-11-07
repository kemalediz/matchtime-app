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
 *   3. Parse. Only our official number's messages and statuses count
 *      (WA_CLOUD_PHONE_NUMBER_ID when set): Meta's test number on the same
 *      app is not ours to answer.
 *   4. Every message is written to `WaInbound` BEFORE the 200, keyed by
 *      (channel, wamid): a repeat writes nothing. A database that refuses
 *      the write is a 500, so Meta sends the POST again (for up to 7
 *      days), which the key makes safe. A message with no text is written
 *      already processed: it still opens his 24 hour window, which the
 *      dispatcher reads here.
 *   5. 200, then the work in `after()`: each text into THE ONE DM PIPELINE
 *      (`handleInboundDm`, channel cloud, plan 5.3), each status onto its
 *      cloud job, template updates to C6, Meta's marketing stop logged for
 *      C8 (plan 5.7: the wiring is C8's).
 *
 * ── NEVER THE SAME WAMID TWICE ─────────────────────────────────────────
 * A text runs only after a compare-and-set claims its row (attempts 0 to
 * 1). Whoever loses (Meta's retry, a second POST, the sweep) runs nothing.
 * Like a DM the Pi forwards, a message is handled AT MOST ONCE: one that
 * fails part way is recorded and not run again, since its answer may
 * already have been queued. A row the work never started (the function
 * died after the 200) is run by `sweepCloudInbound` from the per-minute
 * cron.
 *
 * Logs keep wamids, job ids, phone numbers and Meta's codes; never the
 * text and never a secret (the 2026-10-15 rule).
 */
import { db } from "../db";
import { handleInboundDm, type InboundDm } from "../inbound-dm";
import { onPoolOfferJobFailed, onPoolOfferJobSent } from "../pool/dispatch";
import { cloudApiEnabled, type SendChannel } from "../send-channel";
import { inboundDmOf, parseCloudWebhook, type CloudInboundMessage, type CloudStatusUpdate, type CloudUserPreference, type ParsedCloudWebhook } from "./inbound";
import { cloudStatusUpdate, type StatusJobView } from "./status-rules";
import { applyTemplateStatusPayload } from "./template-status";
import { validMetaSignature } from "./webhook-auth";

type Env = Record<string, string | undefined>;

/** The number these messages came in on, as `WaInbound.channel` stores it. */
const OFFICIAL_NUMBER: SendChannel = "cloud";

/** The sweep leaves a row this long to the work that recorded it. */
export const INBOUND_SWEEP_AFTER_MS = 2 * 60_000;
/** Rows the sweep starts per run (the cron runs every minute). */
export const INBOUND_SWEEP_BATCH = 10;

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

  let payload: unknown;
  try {
    payload = JSON.parse(args.rawBody.toString("utf8"));
  } catch {
    console.error(`${TAG} a signed POST was not JSON; ignored`);
    return { status: 200, body: { ok: true, ignored: "not-json" }, work: null };
  }
  const parsed = oursOnly(parseCloudWebhook(payload), env);
  try {
    await recordInbound(parsed.messages, now());
  } catch (err) {
    console.error(`${TAG} recording ${parsed.messages.length} message(s) failed; Meta will send them again: ${(err as Error)?.name ?? "error"}`);
    return { status: 500, body: { error: "not recorded" }, work: null };
  }
  return { status: 200, body: { ok: true }, work: () => processCloudWebhook(parsed, payload, args.request, now) };
}

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

async function recordInbound(messages: CloudInboundMessage[], now: Date): Promise<void> {
  if (messages.length === 0) return;
  const data = messages.map((m) => {
    const dm = inboundDmOf(m);
    const row = { channel: OFFICIAL_NUMBER, wamid: m.wamid, phone: m.phone, waUserId: m.waUserId, receivedAt: receivedAtOf(m, now) };
    return dm ? { ...row, payload: dm as object } : { ...row, payload: { type: m.type }, processedAt: now, result: `no text: ${m.type}`.slice(0, 64) };
  });
  const { count } = await db.waInbound.createMany({ data, skipDuplicates: true });
  console.log(`${TAG} recorded ${count} of ${messages.length} message(s): ${messages.map((m) => `${m.wamid} from ${m.phone ?? m.waUserId} (${m.type})`).join(", ")}`);
}

/** Step 5: everything after the 200. Never throws. */
async function processCloudWebhook(parsed: ParsedCloudWebhook, payload: unknown, request: Request, now: () => Date): Promise<CloudWebhookReport> {
  const report: CloudWebhookReport = { processed: 0, duplicates: 0, statusesApplied: 0, templateUpdates: 0, preferences: parsed.preferences };

  for (const m of parsed.messages) {
    const dm = inboundDmOf(m);
    if (!dm) continue;
    try {
      if (await runRecorded(m.wamid, dm, request, now)) report.processed++;
      else report.duplicates++;
    } catch (err) {
      // The claim itself failed: the row is unstarted, so the sweep runs it.
      console.error(`${TAG} ${m.wamid}: not claimed, left for the sweep: ${(err as Error)?.name ?? "error"}`);
    }
  }

  for (const st of parsed.statuses) {
    try {
      if (await applyStatus(st, now())) report.statusesApplied++;
    } catch (err) {
      console.error(`${TAG} status ${st.wamid} ${st.status} not applied: ${(err as Error)?.name ?? "error"}`);
    }
  }

  if (parsed.templateUpdates > 0) {
    try {
      const t = await applyTemplateStatusPayload(payload);
      report.templateUpdates = t.written;
    } catch (err) {
      console.error(`${TAG} template updates not written: ${(err as Error)?.name ?? "error"}`);
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

/** Claim the row, run the one DM pipeline, record what it did. False
 *  when somebody else had already claimed it. */
async function runRecorded(wamid: string, dm: InboundDm, request: Request, now: () => Date): Promise<boolean> {
  const row = { channel: OFFICIAL_NUMBER, wamid };
  const { count } = await db.waInbound.updateMany({ where: { ...row, processedAt: null, attempts: 0 }, data: { attempts: 1, result: "processing" } });
  if (count !== 1) {
    console.log(`${TAG} ${wamid}: already taken, not run again`);
    return false;
  }
  let result: string;
  try {
    const res = await handleInboundDm(dm, { channel: OFFICIAL_NUMBER, request });
    result = `${res.status}${await labelOf(res)}`;
  } catch (err) {
    result = `error: ${(err as Error)?.name ?? "error"}`;
    console.error(`${TAG} ${wamid} from ${dm.phone ?? "-"}: the DM pipeline failed; not run again: ${(err as Error)?.name ?? "error"}`);
  }
  try {
    await db.waInbound.updateMany({ where: { ...row, processedAt: null }, data: { processedAt: now(), result } });
  } catch (err) {
    console.error(`${TAG} ${wamid}: marking it processed failed: ${(err as Error)?.name ?? "error"}`);
  }
  console.log(`${TAG} ${wamid} from ${dm.phone ?? "-"}: ${result}`);
  return true;
}

/** The pipeline's own label (`handled` or `ignored`), only when it is a
 *  short token: the result column is shown on the owner page. */
async function labelOf(res: Response): Promise<string> {
  const body = (await res.clone().json().catch(() => null)) as { handled?: unknown; ignored?: unknown } | null;
  const label = body?.handled ?? body?.ignored;
  return typeof label === "string" && LABEL_RE.test(label) ? ` ${label}` : "";
}

/** One status onto its cloud job. True when something was written. */
async function applyStatus(st: CloudStatusUpdate, now: Date): Promise<boolean> {
  const job = (await db.platformJob.findFirst({
    where: { channel: OFFICIAL_NUMBER, OR: [{ waMessageId: st.wamid }, ...(st.jobId ? [{ id: st.jobId, waMessageId: null }] : [])] },
    select: { id: true, status: true, waMessageId: true, sentAt: true, deliveredAt: true, readAt: true },
  })) as StatusJobView | null;
  const price = st.pricing ? ` ${st.pricing.category ?? "?"}${st.pricing.billable === false ? " free" : ""}` : "";
  if (!job) {
    console.log(`${TAG} status ${st.wamid} ${st.status}: no cloud job has it${price}`);
    return false;
  }
  const write = cloudStatusUpdate(job, st, now);
  if (!write) return false;
  const { count } = await db.platformJob.updateMany({ where: { id: job.id, status: job.status }, data: write.data });
  if (count !== 1) return false;
  console.log(`${TAG} status ${st.wamid} ${st.status}: job ${job.id} to ${st.recipient ?? st.recipientUserId ?? "-"}${st.errorCode ? ` code ${st.errorCode}` : ""}${price}`);
  if (write.settles === "sent") await onPoolOfferJobSent(job.id, now, job.sentAt ?? write.data.sentAt ?? now);
  if (write.settles === "failed") await onPoolOfferJobFailed(job.id, now);
  return true;
}

/**
 * Run the recorded messages the work never started (the function died
 * after the 200). From the per-minute cron, with its request. Only rows
 * nobody claimed (attempts 0), older than `INBOUND_SWEEP_AFTER_MS` so the
 * work that recorded them goes first; the claim keeps it to one run.
 * With CLOUD_API_ENABLED off it reads nothing.
 */
export async function sweepCloudInbound(opts: { request: Request; now: Date; env?: Env }): Promise<{ started: number }> {
  if (!cloudApiEnabled(opts.env ?? process.env)) return { started: 0 };
  const rows = (await db.waInbound.findMany({
    where: { channel: OFFICIAL_NUMBER, processedAt: null, attempts: 0, receivedAt: { lt: new Date(opts.now.getTime() - INBOUND_SWEEP_AFTER_MS) } },
    orderBy: { receivedAt: "asc" },
    take: INBOUND_SWEEP_BATCH,
    select: { wamid: true, payload: true },
  })) as Array<{ wamid: string; payload: unknown }>;
  let started = 0;
  for (const r of rows) {
    const dm = r.payload as InboundDm | null;
    if (dm && typeof dm.body === "string" && typeof dm.waMessageId === "string") {
      if (await runRecorded(r.wamid, dm, opts.request, () => opts.now)) started++;
      continue;
    }
    const row = { channel: OFFICIAL_NUMBER, wamid: r.wamid };
    const { count } = await db.waInbound.updateMany({ where: { ...row, processedAt: null, attempts: 0 }, data: { attempts: 1, result: "processing" } });
    if (count === 1) await db.waInbound.updateMany({ where: { ...row, processedAt: null }, data: { processedAt: opts.now, result: "unreadable payload" } });
  }
  if (rows.length > 0) console.log(`${TAG} sweep: ${started} of ${rows.length} unstarted message(s) run`);
  return { started };
}
