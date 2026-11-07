/**
 * META'S TEMPLATE WEBHOOKS, READ (Cloud API plan 5.2 and 5.6, PR C6). Pure:
 * a webhook payload in, the `CloudTemplateStatus` changes out. The webhook
 * route (PR C5) checks the signature and calls `applyTemplateStatusPayload`
 * (`template-status.ts`), which writes them.
 *
 * Two fields, as Meta's webhook reference shows them (read 7 Nov 2026):
 *   message_template_status_update  `event` is the new status (APPROVED,
 *     REJECTED, PAUSED, DISABLED, ...: not a closed list, see `vocab.ts`),
 *     with `reason`, `message_template_category` when given, and for a
 *     rejection `rejection_info`, for a pause `other_info`.
 *   template_category_update  either the change itself (`previous_category`
 *     and `new_category`), or a warning of one to come (`correct_category`
 *     and `category_update_timestamp`, where `new_category` is still the
 *     current one). The warning changes nothing yet: it is a notice for the
 *     owner dashboard (PR C8).
 *
 * Meta retries for up to 7 days and may send a change twice: an upsert by
 * (name, language) makes a repeat harmless. Language codes are stored as
 * Meta sends them, with a hyphen read as an underscore ("en-US" in the
 * category example, "en_US" everywhere else), so the table's CHECK holds.
 * A value the table would refuse (a bad name, language or category) is
 * skipped, never written half.
 */
import { CLOUD_TEMPLATE_CATEGORIES, type CloudTemplateCategory } from "./vocab";

export type TemplateStatusChange =
  | {
      kind: "upsert";
      name: string;
      language: string;
      create: { metaTemplateId: string | null; status: string; category?: CloudTemplateCategory; previousCategory?: CloudTemplateCategory; reason?: string | null };
      update: { metaTemplateId?: string; status?: string; category?: CloudTemplateCategory; previousCategory?: CloudTemplateCategory; reason?: string | null };
    }
  | { kind: "category-upcoming"; name: string; language: string; currentCategory: CloudTemplateCategory | null; correctCategory: CloudTemplateCategory; at: Date | null };

/** The status a row is created with when the first word about it is a
 *  category change: Meta has not told us its status yet. */
export const STATUS_NOT_TOLD = "UNKNOWN";

const NAME_RE = /^[a-z0-9_]{1,512}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const STATUS_RE = /^[A-Z_]{1,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function categoryOf(v: unknown): CloudTemplateCategory | null {
  const s = str(v);
  return s && (CLOUD_TEMPLATE_CATEGORIES as readonly string[]).includes(s) ? (s as CloudTemplateCategory) : null;
}

function idOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

/** Name and language, or null when either would break the table's CHECK. */
function keyOf(value: Obj): { name: string; language: string } | null {
  const name = str(value.message_template_name);
  const language = str(value.message_template_language)?.replace("-", "_") ?? null;
  if (!name || !NAME_RE.test(name) || !language || !LANGUAGE_RE.test(language)) return null;
  return { name, language };
}

/** Why, in Meta's words: the reason code (never "NONE"), then what the
 *  rejection or pause says. Null when Meta gave none. */
function reasonOf(value: Obj): string | null {
  const code = str(value.reason);
  const rejection = isObj(value.rejection_info) ? value.rejection_info : {};
  const other = isObj(value.other_info) ? value.other_info : {};
  const label = (code && code !== "NONE" ? code : null) ?? str(other.title);
  const text = [str(rejection.reason), str(rejection.recommendation), str(other.description)].filter(Boolean).join(" ") || null;
  return label && text ? `${label}: ${text}` : (label ?? text);
}

function statusChange(value: Obj): TemplateStatusChange | null {
  const key = keyOf(value);
  const status = str(value.event);
  if (!key || !status || !STATUS_RE.test(status)) return null;
  const metaTemplateId = idOf(value.message_template_id);
  const category = categoryOf(value.message_template_category);
  const fields = { status, ...(category ? { category } : {}), reason: reasonOf(value) };
  return {
    kind: "upsert",
    ...key,
    create: { metaTemplateId, ...fields },
    update: { ...(metaTemplateId ? { metaTemplateId } : {}), ...fields },
  };
}

function categoryChange(value: Obj): TemplateStatusChange | null {
  const key = keyOf(value);
  if (!key) return null;
  const correct = categoryOf(value.correct_category);
  if (value.correct_category !== undefined) {
    if (!correct) return null;
    const ts = typeof value.category_update_timestamp === "number" ? new Date(value.category_update_timestamp * 1000) : null;
    return { kind: "category-upcoming", ...key, currentCategory: categoryOf(value.new_category), correctCategory: correct, at: ts };
  }
  const now = categoryOf(value.new_category);
  const before = categoryOf(value.previous_category);
  if (!now || (value.previous_category !== undefined && !before)) return null;
  const metaTemplateId = idOf(value.message_template_id);
  const fields = { category: now, ...(before ? { previousCategory: before } : {}) };
  return {
    kind: "upsert",
    ...key,
    create: { metaTemplateId, status: STATUS_NOT_TOLD, ...fields },
    update: { ...(metaTemplateId ? { metaTemplateId } : {}), ...fields },
  };
}

/** Every template status and category change in one webhook POST, in order. */
export function templateStatusChanges(payload: unknown): TemplateStatusChange[] {
  if (!isObj(payload)) return [];
  const out: TemplateStatusChange[] = [];
  for (const entry of list(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of list(entry.changes)) {
      if (!isObj(change) || !isObj(change.value)) continue;
      const c =
        change.field === "message_template_status_update" ? statusChange(change.value) : change.field === "template_category_update" ? categoryChange(change.value) : null;
      if (c) out.push(c);
    }
  }
  return out;
}
