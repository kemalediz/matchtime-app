/**
 * THE CLOUD DISPATCHER'S RULES, THE PURE HALF (WhatsApp Cloud API plan,
 * PR C4). Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md, sections 5.4
 * and 5.5. The I/O half is `dispatch.ts`. No database, no network, no
 * clock: `now` is always passed in.
 *
 * ── FREE FORM OR TEMPLATE (plan 5.4) ───────────────────────────────────
 * He wrote to the official number in the last 24 hours: his window is
 * open, so the job's own text goes as a free form message. Otherwise only
 * a Meta approved template may go: the job's `templateName`, with its
 * `templateParams` as Meta's `components` list (PR C6 fills both). No
 * template and no window: failed, never sent as free form. A template
 * Meta has paused, disabled or not approved (`CloudTemplateStatus`, read
 * by the I/O half) is not used: the job is held until it is green again.
 *
 * ── THE DAILY UNIQUE CAP (plan 5.5) ────────────────────────────────────
 * Meta limits how many people we reach OUTSIDE a window per moving 24
 * hours (250 for a new portfolio). `CLOUD_DAILY_UNIQUE_CAP` (default 200)
 * is our own lower line, counted the same way: a person counts once, and
 * a message inside his window not at all. At the cap a job to a new
 * person is held, except the `first` purposes (codes, placed, answers to
 * his own message), which use the headroom between our cap and Meta's.
 * Within a batch `first` goes first, then `normal`, then `low` (the
 * details question and the club invitation asks).
 *
 * ── THE RETRY COUNT ────────────────────────────────────────────────────
 * A retried job goes back to the queue with `failReason` set to
 * `cloudRetryNote(n, why)`; `cloudRetriesOf` reads the count back. It is
 * our own machine written note on the job (no column was added for it),
 * never anything a person typed.
 */
import { ANSWER_PURPOSES } from "../send-channel";

type Env = Record<string, string | undefined>;

export const CLOUD_DAILY_UNIQUE_CAP_DEFAULT = 200;
/** Meta's customer service window, and its messaging limit's period. */
export const CLOUD_WINDOW_MS = 24 * 3600_000;

/** Our cap on people reached outside a window per moving 24 hours. */
export function cloudDailyUniqueCap(env: Env = process.env): number {
  const raw = (env.CLOUD_DAILY_UNIQUE_CAP ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : CLOUD_DAILY_UNIQUE_CAP_DEFAULT;
}

export type CloudPriority = "first" | "normal" | "low";
const FIRST: readonly string[] = ["otp", "pool-placed", ...ANSWER_PURPOSES];
const LOW: readonly string[] = ["pool-details-ask", "club-invite-ask"];
const RANK: Record<CloudPriority, number> = { first: 0, normal: 1, low: 2 };

export function cloudPriorityOf(purpose: string): CloudPriority {
  if (FIRST.includes(purpose)) return "first";
  if (LOW.includes(purpose)) return "low";
  return "normal";
}

type Inbound = { phone: string | null; receivedAt: Date };

/** Numbers whose 24 hour window with the official number is open now. */
export function openWindowPhones(inbounds: readonly Inbound[], now: Date): Set<string> {
  const from = now.getTime() - CLOUD_WINDOW_MS;
  const out = new Set<string>();
  for (const i of inbounds) if (i.phone && i.receivedAt.getTime() > from && i.receivedAt.getTime() <= now.getTime()) out.add(i.phone);
  return out;
}

/**
 * The people reached outside a window in the last 24 hours: a send in that
 * time with no message from him in the 24 hours before it.
 */
export function reachedOutsideWindow(
  sends: ReadonlyArray<{ phone: string | null; sentAt: Date | null }>,
  inbounds: readonly Inbound[],
  now: Date,
): Set<string> {
  const from = now.getTime() - CLOUD_WINDOW_MS;
  const out = new Set<string>();
  for (const s of sends) {
    if (!s.phone || !s.sentAt || s.sentAt.getTime() <= from || out.has(s.phone)) continue;
    const at = s.sentAt.getTime();
    const inWindow = inbounds.some((i) => i.phone === s.phone && i.receivedAt.getTime() <= at && i.receivedAt.getTime() > at - CLOUD_WINDOW_MS);
    if (!inWindow) out.add(s.phone);
  }
  return out;
}

export const templateKey = (name: string, lang: string) => `${name}:${lang}`;

/** A claimed cloud job, as the plan sees it. */
export interface CloudJobView {
  id: string;
  phone: string;
  purpose: string;
  template: { name: string; lang: string; params: unknown } | null;
}

export type CloudSendPlanItem =
  | { jobId: string; action: "send"; mode: "text" | "template" }
  | { jobId: string; action: "hold"; reason: string }
  | { jobId: string; action: "fail"; reason: string };

/** What to do with each claimed job, in the order to do it. */
export function planCloudSends(
  jobs: readonly CloudJobView[],
  ctx: { cap: number; reached: ReadonlySet<string>; windowOpen: ReadonlySet<string>; unusableTemplates: ReadonlySet<string> },
): CloudSendPlanItem[] {
  const reached = new Set(ctx.reached);
  const ordered = jobs
    .map((j, i) => ({ j, i }))
    .sort((a, b) => RANK[cloudPriorityOf(a.j.purpose)] - RANK[cloudPriorityOf(b.j.purpose)] || a.i - b.i)
    .map(({ j }) => j);
  const out: CloudSendPlanItem[] = [];
  for (const j of ordered) {
    if (ctx.windowOpen.has(j.phone)) {
      out.push({ jobId: j.id, action: "send", mode: "text" });
      continue;
    }
    if (!j.template) {
      out.push({ jobId: j.id, action: "fail", reason: "the 24 hour window is closed and the job has no template" });
      continue;
    }
    if (j.template.params !== null && j.template.params !== undefined && !Array.isArray(j.template.params)) {
      out.push({ jobId: j.id, action: "fail", reason: "malformed template parameters: not a list of Meta components" });
      continue;
    }
    if (ctx.unusableTemplates.has(templateKey(j.template.name, j.template.lang))) {
      out.push({ jobId: j.id, action: "hold", reason: `template ${j.template.name} (${j.template.lang}) is not approved now` });
      continue;
    }
    if (!reached.has(j.phone)) {
      if (cloudPriorityOf(j.purpose) !== "first" && reached.size >= ctx.cap) {
        out.push({ jobId: j.id, action: "hold", reason: `daily unique cap of ${ctx.cap} reached` });
        continue;
      }
      reached.add(j.phone);
    }
    out.push({ jobId: j.id, action: "send", mode: "template" });
  }
  return out;
}

const RETRY_NOTE = /^cloud retry (\d+): /;

export function cloudRetryNote(retries: number, reason: string): string {
  return `cloud retry ${retries}: ${reason}`;
}

export function cloudRetriesOf(failReason: string | null | undefined): number {
  const m = RETRY_NOTE.exec(failReason ?? "");
  return m ? Number(m[1]) : 0;
}
