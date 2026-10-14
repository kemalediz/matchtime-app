/**
 * FETCH A LIST POSTER OR TEAM SHEET BEFORE POSTING IT (2026-10-14).
 *
 * The server's `admin-group-message` can carry an `imageUrl`: a signed,
 * 15-minute link to `/api/graphics/<token>` on MatchTime's own server.
 * The scheduler fetches it here and hands the bytes to
 * `driver.sendImage`. Every doubt is a throw (`GraphicFetchError`), and on
 * a throw the scheduler posts nothing:
 *
 *   - the URL must be on the Pi's own API host (MATCHTIME_API_URL; "www."
 *     or not, same scheme) and under /api/graphics/, checked BEFORE any request, and redirects are
 *     refused, so the Pi never fetches anything else on the server's say;
 *   - 200, `image/png`, PNG magic bytes, at most `MAX_GRAPHIC_BYTES`;
 *   - a timeout, so a slow render cannot wedge the one-at-a-time send
 *     queue (the 2026-06-12 lesson in scheduler.ts).
 *
 * Logs nothing itself; the caller logs the key and the size, never a URL
 * (it carries a token).
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_GRAPHIC_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export class GraphicFetchError extends Error {
  override readonly name = "GraphicFetchError";
}

type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;

export async function fetchGraphic(
  url: string,
  opts: { apiUrl: string; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<Buffer> {
  let target: URL;
  let api: URL;
  try {
    target = new URL(url);
    api = new URL(opts.apiUrl);
  } catch {
    throw new GraphicFetchError("graphic URL is not a URL");
  }
  const host = (u: URL) => u.host.replace(/^www\./, "");
  if (target.protocol !== api.protocol || host(target) !== host(api) || !target.pathname.startsWith("/api/graphics/")) {
    throw new GraphicFetchError("graphic URL is not on MatchTime's own server");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const doFetch: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
    let res: Response;
    try {
      res = await doFetch(target.toString(), { signal: controller.signal, redirect: "error" });
    } catch (err) {
      throw new GraphicFetchError(`graphic fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status !== 200) throw new GraphicFetchError(`graphic fetch answered ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "image/png") throw new GraphicFetchError(`graphic has content type ${type || "none"}`);
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > MAX_GRAPHIC_BYTES) throw new GraphicFetchError(`graphic too big (${length} bytes)`);
    let body: Buffer;
    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new GraphicFetchError(`graphic read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (body.length > MAX_GRAPHIC_BYTES) throw new GraphicFetchError(`graphic too big (${body.length} bytes)`);
    if (body.length < PNG_MAGIC.length || !body.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      throw new GraphicFetchError("graphic is not a PNG");
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
