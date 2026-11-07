/**
 * THE ACCESS TOKEN CHECK on the owner's page (/admin/whatsapp-templates).
 * The template listing failed in production with Meta's "Object with ID
 * '<WABA>' does not exist, cannot be loaded due to missing permissions"; the
 * cause is not known. This reads the facts, server side, without anyone
 * seeing the token:
 *
 *   - `GET /debug_token?input_token=<access token>`, asked with the app's
 *     own token (`<WA_CLOUD_APP_ID>|<WA_CLOUD_APP_SECRET>`): is it valid,
 *     for which app, what type, when it expires, its scopes and the targets
 *     each scope was granted on;
 *   - `GET /<WA_CLOUD_PHONE_NUMBER_ID>?fields=id,display_phone_number,
 *     verified_name` with the access token: can it see the number at all;
 *   - which settings are present (yes or no, and length only), and whether
 *     the token has whitespace or a newline around it;
 *   - the PROBES: more GETs with the access token, each on the configured
 *     version and, where it helps, on v27.0 (`PROBE_NEWER_GRAPH_VERSION`):
 *     the account (`/<WABA>?fields=...`), its numbers, its templates (the
 *     failing call, on v27.0), its subscribed apps, the number's own
 *     account field, and the token's user (`/me`). Each shows Meta's
 *     status, code, subcode, type, fbtrace_id and message, or the answer
 *     (paging links dropped, capped in length).
 *
 * GET only, on the template sync's Graph version (and v27.0 for the
 * probes). Nothing secret comes
 * back: every string in the result is scrubbed of the token, the app secret
 * and the app token, and nothing is logged. `fetch` defaults to the real one
 * (server only), and the real one is refused inside a test run.
 */
import { CLOUD_GRAPH_VERSION, META_GRAPH_BASE } from "./client";

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface TokenCheckDeps {
  fetch: FetchLike;
  env: Env;
}

/** The settings the page lists, present or not. Values never shown. The
 *  official number's own setting is not one of them: it is read only by
 *  club-connect.ts (wa-number-server-only.test.ts), and the phone step
 *  below checks the number through Meta's answer for the phone number id. */
export const TOKEN_CHECK_SETTINGS = [
  "WA_CLOUD_ACCESS_TOKEN",
  "WA_CLOUD_APP_ID",
  "WA_CLOUD_APP_SECRET",
  "WA_CLOUD_WABA_ID",
  "WA_CLOUD_PHONE_NUMBER_ID",
  "WA_CLOUD_GRAPH_VERSION",
  "WA_CLOUD_VERIFY_TOKEN",
  "WA_CLOUD_API_BASE",
] as const;

export interface SettingPresence {
  name: string;
  present: boolean;
  length: number;
  outerWhitespace: boolean;
}

export interface TokenInfo {
  isValid: boolean | null;
  appId: string | null;
  type: string | null;
  application: string | null;
  /** Meta's unix time; 0 means it never expires. */
  expiresAt: number | null;
  dataAccessExpiresAt: number | null;
  issuedAt: number | null;
  scopes: string[];
  /** `targetIds` null: the scope applies to all targets (Meta lists none). */
  granularScopes: { scope: string; targetIds: string[] | null }[];
  userId: string | null;
  error: { code: number | null; subcode: number | null; message: string } | null;
  /** Is WA_CLOUD_WABA_ID listed in any scope's targets (null: no WABA id set). */
  wabaInTargets: boolean | null;
}

type Step<T> = { state: "skipped"; reason: string } | { state: "error"; message: string } | ({ state: "ok" } & T);

/** The newer Graph version every probe that can differ by version is also asked on. */
export const PROBE_NEWER_GRAPH_VERSION = "v27.0";
/** The longest answer a probe shows, so the table stays readable. */
const PROBE_RESULT_MAX = 1000;

/** Meta's error, field by field. `status` null: no HTTP answer at all. */
export interface ProbeError {
  status: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  fbtraceId: string | null;
  message: string;
}

export type ProbeOutcome =
  | { state: "skipped"; reason: string }
  | { state: "error"; error: ProbeError }
  /** `result`: Meta's answer as compact JSON, paging links dropped. */
  | { state: "ok"; status: number; result: string; note?: string };

export interface Probe {
  id: "waba" | "waba-phone-numbers" | "waba-templates" | "phone-waba" | "me" | "waba-subscribed-apps";
  label: string;
  version: string;
  /** The path asked, after the version, with no token in it. */
  path: string;
  outcome: ProbeOutcome;
}

export interface TokenCheck {
  graphVersion: string;
  token: { outerWhitespace: boolean; newline: boolean };
  env: SettingPresence[];
  debug: Step<{ info: TokenInfo }>;
  phone: Step<{ id: string | null; displayPhoneNumber: string | null; verifiedName: string | null }>;
  probes: Probe[];
}

const realDeps = (): TokenCheckDeps => ({ fetch: globalThis.fetch, env: process.env });
const TIMEOUT_MS = 10_000;

const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Takes every secret out of a string, and any token left in a URL. */
function scrubber(env: Env): (s: string) => string {
  const appId = env.WA_CLOUD_APP_ID?.trim();
  const secrets = [env.WA_CLOUD_ACCESS_TOKEN, env.WA_CLOUD_APP_SECRET]
    .flatMap((v) => [v, v?.trim()])
    .filter((v): v is string => !!v && v.trim().length > 0);
  const appSecret = env.WA_CLOUD_APP_SECRET?.trim();
  if (appId && appSecret) {
    const appToken = `${appId}|${appSecret}`;
    secrets.push(appToken, encodeURIComponent(appToken));
  }
  // Longest first, so a secret that contains another is taken out whole.
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  return (s) => {
    let out = s;
    for (const secret of ordered) out = out.split(secret).join("[secret]");
    return out.replace(/(access_token|input_token)=[^&\s]+/gi, "$1=[secret]");
  };
}

/** Every string in the result run through the scrubber: the last lock. */
function scrubDeep<T>(value: T, scrub: (s: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)])) as T;
  }
  return value;
}

async function metaError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string } };
    const e = body.error ?? {};
    const extra = [e.type, e.error_subcode != null ? `subcode ${e.error_subcode}` : null, e.fbtrace_id ? `fbtrace_id ${e.fbtrace_id}` : null].filter(Boolean);
    return `HTTP ${res.status}${e.code != null ? ` ${e.code}` : ""}: ${e.message ?? "no message"}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Meta's error body, field by field, for a probe. */
async function probeError(res: Response): Promise<ProbeError> {
  let e: Record<string, unknown> | null = null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "object" && body.error) e = body.error as Record<string, unknown>;
  } catch {
    // Not JSON: the status is all there is.
  }
  return {
    status: res.status,
    code: num(e?.code),
    subcode: num(e?.error_subcode),
    type: str(e?.type),
    fbtraceId: str(e?.fbtrace_id),
    message: e ? (str(e.message) ?? "no message") : "no JSON error body",
  };
}

const failure = (message: string): ProbeOutcome => ({
  state: "error",
  error: { status: null, code: null, subcode: null, type: null, fbtraceId: null, message },
});

/** Meta's answer as compact JSON, without paging (its `next` link can carry a token), capped. */
function probeResult(body: unknown): string {
  const rest = body && typeof body === "object" && !Array.isArray(body) ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "paging")) : body;
  const out = JSON.stringify(rest) ?? "";
  return out.length > PROBE_RESULT_MAX ? `${out.slice(0, PROBE_RESULT_MAX)}…` : out;
}

/** Whether `appId` is among `/<WABA>/subscribed_apps`'s `data[].whatsapp_business_api_data.id`. */
function subscribedNote(body: unknown, appId: string | undefined): string | undefined {
  if (!appId) return undefined;
  const data = (body as { data?: unknown })?.data;
  const ids = Array.isArray(data) ? data.map((d) => str((d as { whatsapp_business_api_data?: { id?: unknown } })?.whatsapp_business_api_data?.id)) : [];
  return `WA_CLOUD_APP_ID subscribed: ${ids.includes(appId) ? "yes" : "no"}`;
}

function tokenInfo(data: Record<string, unknown>, waba: string | undefined): TokenInfo {
  const granular = Array.isArray(data.granular_scopes) ? (data.granular_scopes as Record<string, unknown>[]) : [];
  const granularScopes = granular.map((g) => ({
    scope: str(g.scope) ?? "",
    targetIds: Array.isArray(g.target_ids) ? (g.target_ids as unknown[]).map((t) => String(t)) : null,
  }));
  const err = data.error as Record<string, unknown> | undefined;
  return {
    isValid: typeof data.is_valid === "boolean" ? data.is_valid : null,
    appId: str(data.app_id),
    type: str(data.type),
    application: str(data.application),
    expiresAt: num(data.expires_at),
    dataAccessExpiresAt: num(data.data_access_expires_at),
    issuedAt: num(data.issued_at),
    scopes: Array.isArray(data.scopes) ? (data.scopes as unknown[]).map((s) => String(s)) : [],
    granularScopes,
    userId: str(data.user_id),
    error: err ? { code: num(err.code), subcode: num(err.subcode), message: str(err.message) ?? "" } : null,
    wabaInTargets: waba ? granularScopes.some((g) => g.targetIds?.includes(waba) ?? false) : null,
  };
}

/** What Meta says about the access token, and whether it sees the number. GET only. */
export async function checkAccessToken(deps: TokenCheckDeps = realDeps()): Promise<TokenCheck> {
  const { env } = deps;
  const scrub = scrubber(env);
  const raw = env.WA_CLOUD_ACCESS_TOKEN ?? "";
  const token = raw.trim();
  const appId = env.WA_CLOUD_APP_ID?.trim();
  const appSecret = env.WA_CLOUD_APP_SECRET?.trim();
  const phoneId = env.WA_CLOUD_PHONE_NUMBER_ID?.trim();
  const waba = env.WA_CLOUD_WABA_ID?.trim() || undefined;
  // The same version the template sync (whose listing failed) asks on.
  const graphVersion = env.WA_CLOUD_GRAPH_VERSION?.trim() || CLOUD_GRAPH_VERSION;
  const base = `${META_GRAPH_BASE}/${graphVersion}`;

  const result: TokenCheck = {
    graphVersion,
    token: { outerWhitespace: raw.length > 0 && raw !== token, newline: /[\r\n]/.test(raw) },
    env: TOKEN_CHECK_SETTINGS.map((name) => {
      const v = env[name];
      const present = typeof v === "string" && v.trim().length > 0;
      return { name, present, length: v?.length ?? 0, outerWhitespace: !!v && v !== v.trim() };
    }),
    debug: { state: "skipped", reason: "" },
    phone: { state: "skipped", reason: "" },
    probes: [],
  };

  // The module's own check on the process, so a test that hands in a
  // made-up env can never reach Meta.
  const refused = (process.env.VITEST || process.env.NODE_ENV === "test" || env.VITEST || env.NODE_ENV === "test") && deps.fetch === globalThis.fetch;
  const get = async (url: string, headers?: Record<string, string>) =>
    deps.fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

  const debugStep = async (): Promise<TokenCheck["debug"]> => {
    if (!token) return { state: "skipped", reason: "WA_CLOUD_ACCESS_TOKEN is not set" };
    const missing = [!appId && "WA_CLOUD_APP_ID", !appSecret && "WA_CLOUD_APP_SECRET"].filter(Boolean);
    if (missing.length) return { state: "skipped", reason: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set` };
    if (refused) return { state: "error", message: "refusing the real fetch in a test run: pass a stub" };
    try {
      const qs = new URLSearchParams({ input_token: token, access_token: `${appId}|${appSecret}` });
      const res = await get(`${base}/debug_token?${qs.toString()}`);
      if (!res.ok) return { state: "error", message: `debug_token failed, ${await metaError(res)}` };
      const body = (await res.json()) as { data?: Record<string, unknown> };
      if (!body.data) return { state: "error", message: "debug_token answered without data" };
      return { state: "ok", info: tokenInfo(body.data, waba) };
    } catch (err) {
      return { state: "error", message: `debug_token failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const phoneStep = async (): Promise<TokenCheck["phone"]> => {
    if (!token) return { state: "skipped", reason: "WA_CLOUD_ACCESS_TOKEN is not set" };
    if (!phoneId) return { state: "skipped", reason: "WA_CLOUD_PHONE_NUMBER_ID is not set" };
    if (refused) return { state: "error", message: "refusing the real fetch in a test run: pass a stub" };
    try {
      const res = await get(`${base}/${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name`, { Authorization: `Bearer ${token}` });
      if (!res.ok) return { state: "error", message: `reading the number failed, ${await metaError(res)}` };
      const body = (await res.json()) as Record<string, unknown>;
      return { state: "ok", id: str(body.id), displayPhoneNumber: str(body.display_phone_number), verifiedName: str(body.verified_name) };
    } catch (err) {
      return { state: "error", message: `reading the number failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  // The probes: each on the configured version and, when it differs, on v27.0
  // (the template listing only on v27.0: the configured one is the sync's own).
  const both = [...new Set([graphVersion, PROBE_NEWER_GRAPH_VERSION])];
  // A skipped probe still shows its path, with the missing setting's name in it.
  const wabaSeg = waba ? encodeURIComponent(waba) : "<WA_CLOUD_WABA_ID>";
  const phoneSeg = phoneId ? encodeURIComponent(phoneId) : "<WA_CLOUD_PHONE_NUMBER_ID>";
  const specs: { id: Probe["id"]; label: string; versions: string[]; path: string; needs: "waba" | "phone" | null }[] = [
    { id: "waba", label: "The account's fields", versions: both, path: `/${wabaSeg}?fields=id,name,currency,timezone_id,message_template_namespace`, needs: "waba" },
    { id: "waba-phone-numbers", label: "The account's numbers", versions: both, path: `/${wabaSeg}/phone_numbers?fields=id,display_phone_number`, needs: "waba" },
    { id: "waba-templates", label: "The account's templates", versions: [PROBE_NEWER_GRAPH_VERSION], path: `/${wabaSeg}/message_templates?limit=1&fields=name,status`, needs: "waba" },
    { id: "phone-waba", label: "The number's account", versions: [graphVersion], path: `/${phoneSeg}?fields=id,whatsapp_business_account`, needs: "phone" },
    { id: "me", label: "The token's user", versions: [graphVersion], path: "/me?fields=id,name", needs: null },
    { id: "waba-subscribed-apps", label: "Apps subscribed to the account", versions: both, path: `/${wabaSeg}/subscribed_apps`, needs: "waba" },
  ];

  const probeStep = async (spec: (typeof specs)[number], version: string): Promise<ProbeOutcome> => {
    if (!token) return { state: "skipped", reason: "WA_CLOUD_ACCESS_TOKEN is not set" };
    if (spec.needs === "waba" && !waba) return { state: "skipped", reason: "WA_CLOUD_WABA_ID is not set" };
    if (spec.needs === "phone" && !phoneId) return { state: "skipped", reason: "WA_CLOUD_PHONE_NUMBER_ID is not set" };
    if (refused) return failure("refusing the real fetch in a test run: pass a stub");
    try {
      const res = await get(`${META_GRAPH_BASE}/${version}${spec.path}`, { Authorization: `Bearer ${token}` });
      if (!res.ok) return { state: "error", error: await probeError(res) };
      const body = (await res.json()) as unknown;
      const note = spec.id === "waba-subscribed-apps" ? subscribedNote(body, appId) : undefined;
      return { state: "ok", status: res.status, result: probeResult(body), ...(note ? { note } : {}) };
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  };

  const probeRuns = specs.flatMap((spec) =>
    spec.versions.map(async (version): Promise<Probe> => ({ id: spec.id, label: spec.label, version, path: spec.path, outcome: await probeStep(spec, version) })),
  );

  let probes: Probe[];
  [result.debug, result.phone, probes] = await Promise.all([debugStep(), phoneStep(), Promise.all(probeRuns)]);
  result.probes = probes;
  return scrubDeep(result, scrub);
}
