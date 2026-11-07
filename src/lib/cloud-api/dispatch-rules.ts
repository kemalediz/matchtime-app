/**
 * THE CLOUD DISPATCHER'S RULES, THE PURE HALF (WhatsApp Cloud API plan,
 * PR C4). Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md, sections 5.4
 * and 5.5. The I/O half is `dispatch.ts`. No database, no network, no
 * clock: `now` is always passed in.
 *
 * ── FREE FORM OR TEMPLATE (plan 5.4) ───────────────────────────────────
 * He wrote to the official number in the last 24 hours: his window is
 * open, so the job's own text goes as a free form message. Otherwise only
 * a Meta approved template may go: the job's `templateName` in Meta's
 * `templateLang`, with `templateParams` as C6's `CloudTemplateParams`
 * (`parseJobTemplate`; the send is built by C6's `templateMessage`). No
 * template and no window: failed, never sent as free form. A template
 * that does not parse (not in the registry, a language it lacks, params
 * that do not fit it) fails the job, window or not. A template Meta has
 * paused, disabled or not approved (`CloudTemplateStatus`, read by the
 * I/O half) is not used: the job is held until it is green again.
 * A code (PR C7a) is the exception both ways: always its `mt_code`
 * template, window or not, and failed rather than held (`CODE_PURPOSE`).
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
import type { Lang } from "../i18n/lang";
import { ANSWER_PURPOSES } from "../send-channel";
import { CLOUD_TEMPLATES, META_LANG, type CloudTemplateName, type CloudTemplateParams, type MetaLang } from "./templates";

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

/** The key of a template in one language: Meta's code, as
 *  `CloudTemplateStatus` stores it. */
export const templateKey = (name: string, metaLang: string) => `${name}:${metaLang}`;

/** A job's template, read back: one C6 can send, or why it cannot. */
export type JobTemplate =
  | { ok: true; name: CloudTemplateName; lang: Lang; metaLang: MetaLang; params: CloudTemplateParams }
  | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The job's `templateName`, `templateLang` and `templateParams` as C6
 * stores them (src/lib/cloud-api/templates.ts): a registry name, Meta's
 * language code (`META_LANG`, the code `CloudTemplateStatus` is keyed by)
 * and `CloudTemplateParams` as `templateParams(...)` filled it. Null when
 * the job has no template. Anything else is refused with a reason, so it
 * is failed and never sent. The values themselves were checked when they
 * were filled; this checks they still fit the registry entry.
 */
export function parseJobTemplate(row: { templateName: string | null; templateLang: string | null; templateParams: unknown }): JobTemplate | null {
  if (row.templateName === null && row.templateLang === null) return null;
  const def = CLOUD_TEMPLATES.find((d) => d.name === row.templateName);
  if (!def) return { ok: false, reason: `template "${row.templateName}" is not in the registry` };
  const lang = (Object.keys(META_LANG) as Lang[]).find((l) => META_LANG[l] === row.templateLang);
  if (!lang || !def.languages.includes(META_LANG[lang])) {
    return { ok: false, reason: `template ${def.name}: language "${row.templateLang}" is not one of ${def.languages.join(", ")}` };
  }
  const refuse = (why: string): JobTemplate => ({ ok: false, reason: `templateParams do not parse as CloudTemplateParams: ${why}` });
  const p = row.templateParams;
  if (!isObj(p) || !Array.isArray(p.body) || !Array.isArray(p.buttons)) return refuse("not { body, buttons }");
  if (p.body.length !== def.vars.length || !p.body.every((v) => typeof v === "string")) {
    return refuse(`body is not ${def.vars.length} text values for ${def.name}`);
  }
  // The buttons that take a value (a URL's end, the code), by index.
  const takes = def.buttons.flatMap((b, i) => (b.kind === "quick_reply" ? [] : [i]));
  const seen = new Set<number>();
  for (const b of p.buttons) {
    if (!isObj(b) || !Number.isInteger(b.index) || typeof b.text !== "string" || !b.text) return refuse("a button is not { index, text }");
    if (!takes.includes(b.index as number) || seen.has(b.index as number)) return refuse(`button ${String(b.index)} does not take a value in ${def.name}, or is given twice`);
    seen.add(b.index as number);
  }
  if (seen.size !== takes.length) return refuse(`${seen.size} button values for ${takes.length} in ${def.name}`);
  return { ok: true, name: def.name, lang, metaLang: META_LANG[lang], params: { body: p.body as string[], buttons: p.buttons as CloudTemplateParams["buttons"] } };
}

/** A claimed cloud job, as the plan sees it. */
export interface CloudJobView {
  id: string;
  phone: string;
  purpose: string;
  template: JobTemplate | null;
}

/**
 * A sign-up, sign-in or claim code (PR C7a): always its authentication
 * template, never free form, since Meta lets only an authentication
 * template carry a one time code (plan section 1). Never held either: a
 * hold (`CLOUD_HOLD_MS`) outlives the code's ten minutes, so a code whose
 * template cannot be used now fails, and the I/O half hands it to the club
 * number while it is alive (`fallbackWhenCloudDown`, decision 5).
 */
const CODE_PURPOSE = "otp";

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
    // A template that does not parse is a broken job: never sent, even as
    // free form inside his window.
    if (j.template && !j.template.ok) {
      out.push({ jobId: j.id, action: "fail", reason: j.template.reason });
      continue;
    }
    const isCode = j.purpose === CODE_PURPOSE;
    if (ctx.windowOpen.has(j.phone) && !isCode) {
      out.push({ jobId: j.id, action: "send", mode: "text" });
      continue;
    }
    if (!j.template) {
      const reason = isCode ? "a code goes only as its authentication template, and the job has none" : "the 24 hour window is closed and the job has no template";
      out.push({ jobId: j.id, action: "fail", reason });
      continue;
    }
    if (ctx.unusableTemplates.has(templateKey(j.template.name, j.template.metaLang))) {
      out.push({ jobId: j.id, action: isCode ? "fail" : "hold", reason: `template ${j.template.name} (${j.template.metaLang}) is not approved now` });
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
