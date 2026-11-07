/**
 * THE TEMPLATE SYNC, RUN FROM THE OWNER'S PAGE (/admin/whatsapp-templates).
 * `WA_CLOUD_ACCESS_TOKEN` is a Vercel secret that cannot be pulled locally,
 * so `scripts/cloud-templates.ts` cannot run on a laptop: the same engine
 * (`syncTemplates`) runs here, on the server, for the platform owner.
 *
 *   - `checkCloudTemplates`: the dry run the page shows. Reads Meta's list
 *     (GET only) and returns the difference. Never submits.
 *   - `submitCloudTemplates`: "Submit to Meta". Submits the new and edits
 *     the changed, and returns what happened per template.
 *
 * Both answer "not-configured" without calling anybody when the WhatsApp
 * Business Account id or the token is missing, and turn any failure into a
 * message with the token scrubbed out, so it can be shown on the page. The
 * token is only ever sent to Meta as a header, never returned and never
 * logged. `fetch` defaults to the real one (on the server only; this module
 * is imported by a server page and a server action, never by the browser),
 * and `syncTemplates` refuses the real one inside a test run.
 */
import { syncTemplates, type SyncReport, type TemplateDiff } from "./template-sync";

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface TemplateSyncDeps {
  fetch: FetchLike;
  env: Env;
}

export type TemplateCheck = { state: "not-configured" } | { state: "error"; message: string } | { state: "ok"; diffs: TemplateDiff[] };
export type TemplateSubmit = { state: "not-configured" } | { state: "error"; message: string } | ({ state: "ok" } & SyncReport);

const realDeps = (): TemplateSyncDeps => ({ fetch: globalThis.fetch, env: process.env });

function configured(env: Env): boolean {
  return !!env.WA_CLOUD_WABA_ID?.trim() && !!env.WA_CLOUD_ACCESS_TOKEN?.trim();
}

/** The error in words, with the token (and any access_token in a URL) taken out. */
function scrubbed(err: unknown, env: Env): string {
  let msg = err instanceof Error ? err.message : String(err);
  const token = env.WA_CLOUD_ACCESS_TOKEN?.trim();
  if (token) msg = msg.split(token).join("[token]");
  return msg.replace(/access_token=[^&\s]+/gi, "access_token=[token]");
}

async function run(deps: TemplateSyncDeps, apply: boolean, log: (line: string) => void): Promise<TemplateSubmit> {
  if (!configured(deps.env)) return { state: "not-configured" };
  // `syncTemplates` refuses the real fetch when the env it is GIVEN says
  // test; this checks the process's own env too, so a test that passes a
  // made-up env can never reach Meta either.
  if ((process.env.VITEST || process.env.NODE_ENV === "test") && deps.fetch === globalThis.fetch) {
    return { state: "error", message: "refusing the real fetch in a test run: pass a stub" };
  }
  try {
    const report = await syncTemplates({ fetch: deps.fetch, env: deps.env, apply, log });
    return { state: "ok", ...report };
  } catch (err) {
    return { state: "error", message: scrubbed(err, deps.env) };
  }
}

/** The page's dry run: what differs between the code and Meta. Reads only. */
export async function checkCloudTemplates(deps: TemplateSyncDeps = realDeps()): Promise<TemplateCheck> {
  const r = await run(deps, false, () => {});
  return r.state === "ok" ? { state: "ok", diffs: r.diffs } : r;
}

/** "Submit to Meta": submit the new templates and edit the changed ones. */
export async function submitCloudTemplates(deps: TemplateSyncDeps = realDeps()): Promise<TemplateSubmit> {
  // The engine's lines carry names, languages and Meta's words, never the
  // token; scrubbed anyway, as a second lock.
  const r = await run(deps, true, (line) => console.log(`[cloud-templates] ${scrubbed(line, deps.env)}`));
  if (r.state === "ok") console.log(`[cloud-templates] submitted from the owner page: ${r.applied.length} done, ${r.skipped.length} skipped, ${r.failed.length} failed`);
  else console.log(`[cloud-templates] submit from the owner page: ${r.state === "error" ? r.message : "not configured"}`);
  return r;
}
