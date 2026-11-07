/**
 * THE TEMPLATE REGISTRY AGAINST META (Cloud API plan 5.6, PR C6). The
 * engine of `scripts/cloud-templates.ts`: read every template on the
 * WhatsApp Business Account (`GET /<WABA_ID>/message_templates`, every
 * page), compare it with `templates.ts`, print the difference, and only
 * with `--apply` submit the new ones and edit the changed ones.
 *
 * Safe by default:
 *   - A dry run unless `--apply` is passed exactly (`parseSyncArgs`).
 *   - `fetch` is passed in, never taken from the global, and the real one
 *     is refused inside a test run: tests stub it, nothing reaches Meta.
 *   - Nothing is ever deleted. A template of ours Meta holds and the
 *     registry does not is reported as "not-ours" for a person to decide.
 *   - Meta's category is reported, never fought: a utility template Meta
 *     approved as marketing (decision 1) stays as Meta has it.
 *   - Meta lets an approved, rejected or paused template be edited, not a
 *     pending one: a pending change is reported and skipped.
 *   - The token is sent as a header and never printed.
 *
 * An authentication template's words are Meta's own (`mt_code`), so it is
 * compared by presence only.
 */
import { CLOUD_TEMPLATES, META_LANG, metaComponents, type CloudTemplateDef, type MetaTemplateComponent } from "./templates";
import type { Lang } from "../i18n/lang";

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_GRAPH_VERSION = "v26.0";
const EDITABLE = new Set(["APPROVED", "REJECTED", "PAUSED"]);

/** One template as Meta lists it. */
export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: MetaTemplateComponent[];
}

export interface TemplateDiff {
  name: string;
  language: string;
  kind: "new" | "changed" | "same" | "not-ours";
  metaId?: string;
  metaStatus?: string;
  /** Meta's category, when it is not the one we submitted. */
  metaCategory?: string;
  /** What differs: "body", "buttons". */
  changes?: string[];
}

export interface SyncReport {
  diffs: TemplateDiff[];
  applied: Array<{ name: string; language: string; action: "created" | "edited" }>;
  skipped: Array<{ name: string; language: string; why: string }>;
  failed: Array<{ name: string; language: string; why: string }>;
}

/** `--apply` exactly, or nothing: anything else is refused. */
export function parseSyncArgs(argv: readonly string[]): { apply: boolean } {
  const unknown = argv.filter((a) => a !== "--apply");
  if (unknown.length) throw new Error(`unknown argument ${unknown.map((a) => JSON.stringify(a)).join(", ")}: the only one is --apply`);
  return { apply: argv.includes("--apply") };
}

const LANG_OF: Record<string, Lang> = Object.fromEntries(Object.entries(META_LANG).map(([lang, code]) => [code, lang as Lang]));

/** The parts of a template we decide, in a form both sides compare in. */
function shape(components: readonly MetaTemplateComponent[]) {
  const body = components.find((c) => c.type === "BODY");
  const buttons = components.find((c) => c.type === "BUTTONS");
  const list = Array.isArray(buttons?.buttons) ? (buttons.buttons as Array<Record<string, unknown>>) : [];
  return {
    body: typeof body?.text === "string" ? body.text : null,
    buttons: JSON.stringify(list.map((b) => ({ type: b.type, text: b.text, url: b.url ?? null }))),
  };
}

function compare(def: CloudTemplateDef, lang: Lang, meta: MetaTemplate): string[] {
  if (def.category === "AUTHENTICATION") return [];
  const ours = shape(metaComponents(def.name, lang));
  const theirs = shape(meta.components ?? []);
  return [ours.body !== theirs.body ? "body" : null, ours.buttons !== theirs.buttons ? "buttons" : null].filter((x): x is string => !!x);
}

/** The registry, every language, against what Meta holds. */
export function diffTemplates(meta: readonly MetaTemplate[]): TemplateDiff[] {
  const held = new Map(meta.map((m) => [`${m.name}|${m.language}`, m]));
  const out: TemplateDiff[] = [];
  const ours = new Set<string>();
  for (const def of CLOUD_TEMPLATES) {
    for (const language of def.languages) {
      const key = `${def.name}|${language}`;
      ours.add(key);
      const m = held.get(key);
      if (!m) {
        out.push({ name: def.name, language, kind: "new" });
        continue;
      }
      const changes = compare(def, LANG_OF[language], m);
      out.push({
        name: def.name,
        language,
        kind: changes.length ? "changed" : "same",
        metaId: m.id,
        metaStatus: m.status,
        ...(m.category && m.category !== def.category ? { metaCategory: m.category } : {}),
        ...(changes.length ? { changes } : {}),
      });
    }
  }
  for (const m of meta) {
    if (m.name.startsWith("mt_") && !ours.has(`${m.name}|${m.language}`)) {
      out.push({ name: m.name, language: m.language, kind: "not-ours", metaId: m.id, metaStatus: m.status });
    }
  }
  return out;
}

function line(d: TemplateDiff): string {
  const meta = d.metaStatus ? ` (Meta: ${d.metaStatus}${d.metaCategory ? `, category ${d.metaCategory}` : ""})` : "";
  const what = d.kind === "changed" ? `changed: ${d.changes!.join(", ")}` : d.kind;
  return `  ${d.name} ${d.language}: ${what}${meta}`;
}

async function metaError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: number } };
    return `HTTP ${res.status}${body.error?.code ? ` ${body.error.code}` : ""}: ${body.error?.message ?? "no message"}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Read Meta's templates, print the difference, and with `apply` submit it. */
export async function syncTemplates(opts: { fetch: FetchLike; env: Env; apply: boolean; log: (line: string) => void }): Promise<SyncReport> {
  const { env, apply, log } = opts;
  const waba = env.WA_CLOUD_WABA_ID?.trim();
  const token = env.WA_CLOUD_ACCESS_TOKEN?.trim();
  if (!waba || !token) throw new Error("WA_CLOUD_WABA_ID and WA_CLOUD_ACCESS_TOKEN must be set");
  if ((env.VITEST || env.NODE_ENV === "test") && opts.fetch === globalThis.fetch) throw new Error("refusing the real fetch in a test run: pass a stub");
  const base = `https://graph.facebook.com/${env.WA_CLOUD_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const meta: MetaTemplate[] = [];
  let url: string | null = `${base}/${waba}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  while (url) {
    const res = await opts.fetch(url, { method: "GET", headers });
    if (!res.ok) throw new Error(`listing templates failed, ${await metaError(res)}`);
    const page = (await res.json()) as { data?: MetaTemplate[]; paging?: { next?: string } };
    meta.push(...(page.data ?? []));
    url = page.paging?.next ?? null;
  }

  const diffs = diffTemplates(meta);
  const report: SyncReport = { diffs, applied: [], skipped: [], failed: [] };
  log(`${apply ? "APPLY" : "Dry run (pass --apply to submit)"}: ${CLOUD_TEMPLATES.length} templates, ${meta.length} held by Meta`);
  for (const kind of ["new", "changed", "not-ours", "same"] as const) {
    const of = diffs.filter((d) => d.kind === kind);
    if (of.length) log([`${kind} (${of.length}):`, ...of.map(line)].join("\n"));
  }
  if (!apply) return report;

  const post = async (d: TemplateDiff, to: string, body: object, action: "created" | "edited") => {
    const res = await opts.fetch(to, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.ok) {
      report.applied.push({ name: d.name, language: d.language, action });
      log(`  ${action} ${d.name} ${d.language}`);
    } else {
      const why = await metaError(res);
      report.failed.push({ name: d.name, language: d.language, why });
      log(`  FAILED ${d.name} ${d.language}: ${why}`);
    }
  };
  for (const d of diffs) {
    const def = CLOUD_TEMPLATES.find((t) => t.name === d.name);
    if (!def) continue;
    const components = metaComponents(def.name, LANG_OF[d.language]);
    if (d.kind === "new") {
      await post(d, `${base}/${waba}/message_templates`, { name: d.name, language: d.language, category: def.category, components }, "created");
    } else if (d.kind === "changed") {
      if (!EDITABLE.has(d.metaStatus ?? "")) {
        const why = `${d.metaStatus} at Meta: edit it once reviewed`;
        report.skipped.push({ name: d.name, language: d.language, why });
        log(`  skipped ${d.name} ${d.language}: ${why}`);
        continue;
      }
      await post(d, `${base}/${d.metaId}`, { components }, "edited");
    }
  }
  return report;
}
