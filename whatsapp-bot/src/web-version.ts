/**
 * WhatsApp Web version pinning — an escape hatch we can turn without a
 * code deploy.
 *
 * ── Why (2026-08-28) ─────────────────────────────────────────────────
 * whatsapp-web.js drives a real WhatsApp Web page in headless Chromium and
 * injects code against WhatsApp's own (minified, unversioned, undocumented)
 * internals. When WhatsApp ships a frontend change, those internals move and
 * every injected call starts throwing — on the Pi this showed up as the
 * minified `r: r` error from `Client.getChats()`, `getChatById()` and the
 * `sendMessage()` model builder, after a ~5-week idle period over the summer.
 *
 * whatsapp-web.js already supports pinning the WhatsApp Web build it loads:
 * `webVersion` picks the build, `webVersionCache` says where to fetch it
 * from. The community keeps an archive of built index.html files at
 * wppconnect-team/wa-version. Pinning to a build the installed library is
 * known to work against is the standard mitigation while upstream catches up.
 *
 * Hard-coding that would mean a code change + deploy every time WhatsApp
 * breaks us. Instead it's env-driven, so the Pi can be re-pinned by editing
 * `~/matchtime-bot/.env` and restarting via `scripts/deploy-pi.sh`.
 *
 * ── Env vars ─────────────────────────────────────────────────────────
 *   WA_WEB_VERSION             e.g. "2.3000.1032157364" — pin this build,
 *                              fetched from the wa-version archive.
 *   WA_WEB_VERSION_REMOTE_PATH full URL override for where to fetch the
 *                              index.html from. May contain the literal
 *                              "{version}" placeholder, which whatsapp-web.js
 *                              substitutes with WA_WEB_VERSION.
 *   WA_WEB_VERSION_CACHE_TYPE  "none" | "local" | "remote". Only consulted
 *                              when neither of the above is set. "none"
 *                              means: always take WhatsApp's live build.
 *
 * With NONE of them set this resolves to `{}` — the client is constructed
 * exactly as before, so nothing changes for anyone who doesn't opt in.
 */

/** Archive of built WhatsApp Web index.html files, maintained by wppconnect. */
export const WA_VERSION_ARCHIVE_TEMPLATE =
  "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html";

export type WebVersionCache =
  | { type: "remote"; remotePath: string }
  | { type: "local" }
  | { type: "none" };

export interface WebVersionOptions {
  webVersion?: string;
  webVersionCache?: WebVersionCache;
}

function clean(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Translate the WA_WEB_VERSION* env vars into the subset of
 * whatsapp-web.js `ClientOptions` that controls which WhatsApp Web build is
 * loaded. Returns `{}` when unconfigured (library defaults preserved).
 *
 * Pure — takes the env explicitly so it can be unit-tested.
 */
export function resolveWebVersionOptions(
  env: Record<string, string | undefined>,
): WebVersionOptions {
  const version = clean(env.WA_WEB_VERSION);
  const remotePath = clean(env.WA_WEB_VERSION_REMOTE_PATH);

  // 1. An explicit remote path always wins — it's the most direct override
  //    and it works with or without a version (a fully-literal URL is fine).
  if (remotePath) {
    return version
      ? { webVersion: version, webVersionCache: { type: "remote", remotePath } }
      : { webVersionCache: { type: "remote", remotePath } };
  }

  // 2. A bare version pin fetches from the community archive.
  if (version) {
    return {
      webVersion: version,
      webVersionCache: { type: "remote", remotePath: WA_VERSION_ARCHIVE_TEMPLATE },
    };
  }

  // 3. Explicit cache-type override with no version.
  const cacheType = clean(env.WA_WEB_VERSION_CACHE_TYPE)?.toLowerCase();
  if (cacheType === "none") return { webVersionCache: { type: "none" } };
  if (cacheType === "local") return { webVersionCache: { type: "local" } };
  // "remote" with no remotePath would make RemoteWebCache throw in its
  // constructor and take the whole bot down at startup. Ignore it.

  // 4. Unconfigured — library defaults, behaviour identical to before.
  return {};
}

/** Human-readable one-liner for the startup log. */
export function describeWebVersionOptions(opts: WebVersionOptions): string {
  if (!opts.webVersionCache) return "WhatsApp Web version: library default (unpinned)";
  const cache = opts.webVersionCache;
  const where = cache.type === "remote" ? ` from ${resolvedRemotePath(opts) ?? "?"}` : "";
  return `WhatsApp Web version: ${opts.webVersion ?? "(library default)"} via ${cache.type} cache${where}`;
}

/**
 * The URL whatsapp-web.js will actually fetch, with `{version}` substituted
 * exactly the way `RemoteWebCache.resolve()` does it. Returns undefined for
 * non-remote configurations.
 */
export function resolvedRemotePath(opts: WebVersionOptions): string | undefined {
  const cache = opts.webVersionCache;
  if (!cache || cache.type !== "remote") return undefined;
  return cache.remotePath.replace("{version}", opts.webVersion ?? "");
}

/**
 * Warn if a pinned build isn't actually in the archive.
 *
 * `RemoteWebCache` is non-strict: a 404 resolves to null and whatsapp-web.js
 * SILENTLY falls back to WhatsApp's live build. So a typo'd pin, or a pin to
 * a build the archive has since pruned (wa-version keeps only a rolling
 * window — the library's own default 2.3000.1017054665 already 404s there),
 * looks exactly like a working pin in the logs while changing nothing.
 *
 * Warn-only and fully contained: never throws, never blocks startup.
 */
export async function warnIfPinUnreachable(
  opts: WebVersionOptions,
  log: (msg: string) => void = console.error,
  timeoutMs = 5_000,
): Promise<void> {
  const url = resolvedRemotePath(opts);
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(
        `CRITICAL: pinned WhatsApp Web build is NOT reachable (HTTP ${res.status} for ${url}). ` +
          "whatsapp-web.js falls back SILENTLY to WhatsApp's live build, so this pin is doing " +
          "nothing. Pick a build that exists in the archive — the wa-version repo prunes old " +
          "ones. See MDs/whatsapp-web-version-pinning.md.",
      );
    }
  } catch (err) {
    log(
      `Could not verify the pinned WhatsApp Web build at ${url} ` +
        `(${err instanceof Error ? err.message : String(err)}). Continuing.`,
    );
  }
}
