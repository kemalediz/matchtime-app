/**
 * THE CLOUD DISPATCHER, THE I/O HALF (WhatsApp Cloud API plan, PR C4).
 * Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md, sections 5.4, 5.5 and
 * 5.8. The rules are `dispatch-rules.ts` and `errors.ts`; the request is
 * `client.ts`.
 *
 * ── ONE CLAIM, ONE OUTCOME WRITER ──────────────────────────────────────
 * Jobs are claimed with THE SAME function as the Pi's,
 * `claimDuePlatformJobs`, for the official number's channel: codes first,
 * a code past its ten minutes failed, pool offers admitted under the
 * platform cap's lock (switches, his caps, quiet hours) all stay in one
 * place. The claim is the compare-and-set BEFORE the send, so a job is
 * sent at most once (Meta has no idempotency key). Every outcome is
 * written by `recordPlatformJobOutcome`, the Pi's own writer, so a pool
 * offer's delivery, failure and cancellation follow the same rules on
 * both numbers.
 *
 * ── ONE RUN ────────────────────────────────────────────────────────────
 *   1. CLOUD_API_ENABLED off: return at once. Nothing is read, claimed or
 *      sent, so behaviour is exactly what it was before the plan.
 *   2. The official number not configured (no token or phone number id;
 *      in test mode, no stub address): nothing is claimed, the jobs wait.
 *   3. Claim up to `CLOUD_BATCH` DMs for the official number.
 *   4. Read what the rules need: each job's template, who wrote to the
 *      official number lately (his window), who we reached outside a
 *      window in the last 24 hours (the daily unique cap) and which
 *      templates Meta has not approved now.
 *   5. `planCloudSends`: send as text or template, hold, or fail.
 *   6. Send, classify (`classifyCloudSend`), record. 131047 on a free form
 *      send is resent once as the job's template. A retry goes back to
 *      the queue after its backoff, the count in its note; a hold waits
 *      `CLOUD_HOLD_MS`. 132015 and 132016 flag the template in
 *      `CloudTemplateStatus`; 131050 is reported for the opt-out wiring
 *      (PR C8).
 *   7. A sign-up code the official number could not send is handed to
 *      the club number while it is still alive (`fallbackWhenCloudDown`,
 *      plan section 6 item 5). Nothing else ever falls back, and an
 *      unconfirmed code is never handed over (it may have landed).
 *
 * Runs right after a cloud job is queued (`after()`, kick.ts) and from
 * the per-minute sweep (/api/cron/cloud-dispatch). Two runs at once never
 * send one job twice (the claim); together they may pass the daily cap by
 * at most one batch, inside the headroom between our cap and Meta's.
 *
 * Logs carry job ids, purposes, numbers and Meta's codes; never the text
 * and never the token (the 2026-10-15 rule).
 */
import { db } from "../db";
import { OTP_DM_TTL_MS, claimDuePlatformJobs, recordPlatformJobOutcome, type PlatformJobOutcome } from "../platform-jobs";
import { runPlatformPoolSweeps } from "../pool/platform-sweeps";
import { resolvePoolEnv } from "../pool/switch-env";
import { cloudApiEnabled, fallbackWhenCloudDown, type SendChannel } from "../send-channel";
import { cloudApiConfigFrom, sendCloudMessage, type CloudApiConfig, type CloudOutgoing } from "./client";
import {
  CLOUD_WINDOW_MS,
  cloudDailyUniqueCap,
  cloudRetriesOf,
  cloudRetryNote,
  openWindowPhones,
  parseJobTemplate,
  planCloudSends,
  reachedOutsideWindow,
  templateKey,
  type CloudJobView,
} from "./dispatch-rules";
import { classifyCloudSend, type CloudSendResult, type CloudSendVerdict } from "./errors";
import { templateMessage } from "./templates";

type Env = Record<string, string | undefined>;

/** The official number's jobs, as `PlatformJob.channel` stores them. */
const OFFICIAL_NUMBER: SendChannel = "cloud";

/** Jobs claimed per run. The sweep runs every minute. */
export const CLOUD_BATCH = 10;
/** A held job (daily cap, template not approved) waits this long. */
export const CLOUD_HOLD_MS = 15 * 60_000;
/** Meta's template status that may be used. */
const APPROVED = "APPROVED";

export interface CloudDispatchReport {
  enabled: boolean;
  configured: boolean;
  claimed: number;
  sent: number;
  unconfirmed: number;
  retried: number;
  held: number;
  failed: number;
  handedOver: number;
  /** Numbers Meta says stopped marketing messages (131050), for PR C8. */
  stopMarketing: string[];
  /** Templates flagged paused or disabled on this run, "name:lang". */
  flaggedTemplates: string[];
}

interface JobRow {
  id: string;
  phone: string | null;
  text: string | null;
  purpose: string;
  createdAt: Date;
  failReason: string | null;
  templateName: string | null;
  templateLang: string | null;
  templateParams: unknown;
}

/**
 * The per-minute sweep (/api/cron/cloud-dispatch). With CLOUD_API_ENABLED
 * off it does nothing at all: not even the pool switch is read, and the
 * pool's sweeps stay the Pi's alone, exactly as before. On, it first runs
 * the pool's sweeps the Pi runs (`runPlatformPoolSweeps`, the same
 * function), so pool offers no longer depend on the Pi being up, then
 * dispatches. `poolEnv` resolves the pool switch once, for both.
 */
export async function runCloudDispatchSweep(opts: { now: Date; env?: Env; poolEnv: () => Promise<Env> }): Promise<CloudDispatchReport> {
  const env = opts.env ?? process.env;
  if (!cloudApiEnabled(env)) return emptyReport(false, false);
  const poolEnv = await opts.poolEnv();
  await runPlatformPoolSweeps(opts.now, poolEnv, "cloud-dispatch");
  return dispatchCloudJobs({ now: opts.now, env, poolEnv });
}

function emptyReport(enabled: boolean, configured: boolean): CloudDispatchReport {
  return { enabled, configured, claimed: 0, sent: 0, unconfirmed: 0, retried: 0, held: 0, failed: 0, handedOver: 0, stopMarketing: [], flaggedTemplates: [] };
}

let warnedUnconfigured = false;

export async function dispatchCloudJobs(
  opts: {
    now?: Date;
    env?: Env;
    /** The pool switch, already resolved by the caller (a request's). */
    poolEnv?: Env;
    timeoutMs?: number;
    send?: (config: CloudApiConfig, msg: CloudOutgoing) => Promise<CloudSendResult>;
  } = {},
): Promise<CloudDispatchReport> {
  const env = opts.env ?? process.env;
  if (!cloudApiEnabled(env)) return emptyReport(false, false);
  const config = cloudApiConfigFrom(env);
  if (!config) {
    if (!warnedUnconfigured) console.error("[cloud-api] the Cloud API is switched on but the official number is not configured; cloud jobs wait");
    warnedUnconfigured = true;
    return emptyReport(true, false);
  }
  const now = opts.now ?? new Date();
  const report = emptyReport(true, true);
  const send = opts.send ?? ((c: CloudApiConfig, m: CloudOutgoing) => sendCloudMessage(c, m, { timeoutMs: opts.timeoutMs }));

  const poolEnv = opts.poolEnv ?? (await resolvePoolEnv(undefined, env));
  const claimed = await claimDuePlatformJobs({ now, kinds: ["dm"], limit: CLOUD_BATCH, env: poolEnv, channel: OFFICIAL_NUMBER });
  report.claimed = claimed.length;
  if (claimed.length === 0) return report;

  const rows = (await db.platformJob.findMany({
    where: { id: { in: claimed.map((j) => j.id) } },
    select: { id: true, phone: true, text: true, purpose: true, createdAt: true, failReason: true, templateName: true, templateLang: true, templateParams: true },
  })) as JobRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const jobs: CloudJobView[] = [];
  for (const r of rows) {
    if (!r.phone) continue;
    jobs.push({ id: r.id, phone: r.phone, purpose: r.purpose, template: parseJobTemplate(r) });
  }

  const recent = (await db.platformJob.findMany({
    where: { channel: OFFICIAL_NUMBER, status: { in: ["sent", "unconfirmed"] }, sentAt: { gt: new Date(now.getTime() - CLOUD_WINDOW_MS) } },
    select: { phone: true, sentAt: true },
  })) as Array<{ phone: string | null; sentAt: Date | null }>;
  const phones = [...new Set([...jobs.map((j) => j.phone), ...recent.map((s) => s.phone).filter((p): p is string => !!p)])];
  const inbounds = (await db.waInbound.findMany({
    where: { channel: OFFICIAL_NUMBER, phone: { in: phones }, receivedAt: { gt: new Date(now.getTime() - 2 * CLOUD_WINDOW_MS) } },
    select: { phone: true, receivedAt: true },
  })) as Array<{ phone: string | null; receivedAt: Date }>;
  const templates = jobs.flatMap((j) => (j.template?.ok ? [{ name: j.template.name, language: j.template.metaLang }] : []));
  const statuses = templates.length
    ? ((await db.cloudTemplateStatus.findMany({ where: { OR: templates }, select: { name: true, language: true, status: true } })) as Array<{ name: string; language: string; status: string }>)
    : [];
  const unusableTemplates = new Set(statuses.filter((s) => s.status !== APPROVED).map((s) => templateKey(s.name, s.language)));

  const plan = planCloudSends(jobs, {
    cap: cloudDailyUniqueCap(env),
    reached: reachedOutsideWindow(recent, inbounds, now),
    windowOpen: openWindowPhones(inbounds, now),
    unusableTemplates,
  });

  for (const item of plan) {
    const r = byId.get(item.jobId)!;
    const job = jobs.find((j) => j.id === item.jobId)!;
    const tag = `[cloud-api] job ${r.id} (${r.purpose}) to ${r.phone}`;
    try {
      if (item.action === "hold") {
        const retries = cloudRetriesOf(r.failReason);
        const note = retries > 0 ? cloudRetryNote(retries, `held: ${item.reason}`) : `cloud hold: ${item.reason}`;
        await record(r.id, { outcome: "requeue", sendAfter: new Date(now.getTime() + CLOUD_HOLD_MS), note });
        report.held++;
        console.log(`${tag}: held, ${item.reason}`);
        continue;
      }
      if (item.action === "fail") {
        // A template that does not parse is our own broken job: failed and
        // never sent on either number, a code included.
        if (job.template && !job.template.ok) await fail(r, item.reason, null);
        else await failOrHandOver(r, item.reason, null);
        continue;
      }
      const verdict = await sendJob(r, job, item.mode);
      await apply(r, job, verdict);
    } catch (err) {
      // The job stays claimed: at most once. A pool offer left claimed is
      // taken as delivered after five minutes (stampUnreportedDeliveries).
      console.error(`${tag}: recording the outcome failed: ${(err as Error)?.message ?? "error"}`);
    }
  }
  return report;

  async function record(id: string, outcome: PlatformJobOutcome): Promise<void> {
    await recordPlatformJobOutcome(id, outcome, now);
  }

  async function sendJob(r: JobRow, job: CloudJobView, mode: "text" | "template"): Promise<CloudSendVerdict> {
    const ctx = { retriesSoFar: cloudRetriesOf(r.failReason), now, expiresAt: r.purpose === "otp" ? new Date(r.createdAt.getTime() + OTP_DM_TTL_MS) : null };
    // C6 owns the template's wire shape: `templateMessage` builds it.
    const t = job.template?.ok && !unusableTemplates.has(templateKey(job.template.name, job.template.metaLang)) ? job.template : null;
    const asTemplate = (): CloudOutgoing | null => (t ? { jobId: r.id, to: job.phone, kind: "template", message: templateMessage(t.name, t.lang, t.params) } : null);
    const first: CloudOutgoing | null = mode === "text" ? { jobId: r.id, to: job.phone, kind: "text", text: r.text ?? "" } : asTemplate();
    if (!first) return { verdict: "failed", errorCode: null, reason: "the job's template cannot be used" };
    const verdict = classifyCloudSend(await send(config!, first), ctx);
    if (verdict.verdict !== "window-closed" || first.kind !== "text") return verdict;
    // Meta says his window is closed after all: the template, once.
    const second = asTemplate();
    if (!second || !t) return verdict;
    console.log(`[cloud-api] job ${r.id}: window closed (131047), resending as template ${t.name}`);
    return classifyCloudSend(await send(config!, second), ctx);
  }

  async function apply(r: JobRow, job: CloudJobView, v: CloudSendVerdict): Promise<void> {
    const tag = `[cloud-api] job ${r.id} (${r.purpose}) to ${r.phone}`;
    switch (v.verdict) {
      case "sent":
        await record(r.id, { outcome: "sent", waMessageId: v.wamid });
        report.sent++;
        console.log(`${tag}: sent ${v.wamid}`);
        return;
      case "unconfirmed":
        await record(r.id, { outcome: "unconfirmed", reason: v.reason, sentAt: now, errorCode: v.errorCode });
        report.unconfirmed++;
        console.warn(`${tag}: unconfirmed, ${v.reason}`);
        return;
      case "retry": {
        const n = cloudRetriesOf(r.failReason) + 1;
        await record(r.id, { outcome: "requeue", sendAfter: v.retryAt, note: cloudRetryNote(n, v.reason), errorCode: v.errorCode });
        report.retried++;
        console.warn(`${tag}: retry ${n} at ${v.retryAt.toISOString()}, ${v.reason}`);
        return;
      }
      case "window-closed":
        await failOrHandOver(r, v.reason, v.errorCode);
        return;
      case "failed":
        if (v.flagTemplate && job.template?.ok) {
          const { name, metaLang } = job.template;
          const key = templateKey(name, metaLang);
          await db.cloudTemplateStatus.upsert({
            where: { name_language: { name, language: metaLang } },
            create: { name, language: metaLang, status: v.flagTemplate, reason: v.reason },
            update: { status: v.flagTemplate, reason: v.reason },
          });
          unusableTemplates.add(key);
          report.flaggedTemplates.push(key);
          console.error(`[cloud-api] template ${key} flagged ${v.flagTemplate}: not used until it is approved again`);
        }
        if (v.stopMarketing && r.phone) {
          report.stopMarketing.push(r.phone);
          console.warn(`${tag}: he stopped marketing messages (131050)`);
        }
        await failOrHandOver(r, v.reason, v.errorCode);
        return;
    }
  }

  async function failOrHandOver(r: JobRow, reason: string, errorCode: number | null): Promise<void> {
    const tag = `[cloud-api] job ${r.id} (${r.purpose}) to ${r.phone}`;
    const fallback = fallbackWhenCloudDown(r.purpose);
    const alive = r.purpose !== "otp" || now.getTime() - r.createdAt.getTime() < OTP_DM_TTL_MS;
    if (fallback && fallback !== OFFICIAL_NUMBER && alive) {
      await record(r.id, { outcome: "handover", channel: fallback, note: `handed to the club number: ${reason}`, errorCode });
      report.handedOver++;
      console.warn(`${tag}: handed to the club number, ${reason}`);
      return;
    }
    await fail(r, reason, errorCode);
  }

  async function fail(r: JobRow, reason: string, errorCode: number | null): Promise<void> {
    await record(r.id, { outcome: "failed", reason, errorCode });
    report.failed++;
    console.error(`[cloud-api] job ${r.id} (${r.purpose}) to ${r.phone}: failed, ${reason}`);
  }
}
