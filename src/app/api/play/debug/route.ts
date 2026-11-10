/**
 * POST /api/play/debug: TEMPORARY (2026-11-10), the /play funnel
 * diagnostic's endpoint (`src/app/play/funnel-debug.ts`). Only a page opened
 * with `?mtdebug=1` ever calls it. Remove it with the diagnostic once the
 * reason the Facebook in-app browser sent no beacon is known.
 *
 * Writes one `[pool-funnel-debug] {json}` line per valid batch, with the
 * user agent, to the server log, and stores nothing. Small JSON only (16 KB),
 * known fields only (`funnel-debug-batch.ts`), 60 batches per IP an hour.
 */
import { FUNNEL_DEBUG_MAX_BYTES, createRateLimiter, funnelDebugLogLine, readFunnelDebugBatch } from "@/app/play/funnel-debug-batch";

const LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 };
let allow = createRateLimiter(LIMIT);

/** Tests only: a fresh hour for every IP. */
export function resetDebugLimitForTests() {
  allow = createRateLimiter(LIMIT);
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > FUNNEL_DEBUG_MAX_BYTES) return new Response(null, { status: 413 });
  const text = await request.text().catch(() => "");
  if (new TextEncoder().encode(text).length > FUNNEL_DEBUG_MAX_BYTES) return new Response(null, { status: 413 });
  if (!allow(clientIp(request), Date.now())) return new Response(null, { status: 429 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const batch = readFunnelDebugBatch(parsed);
  if (!batch) return new Response(null, { status: 400 });
  console.info(funnelDebugLogLine(batch, request.headers.get("user-agent")));
  return new Response(null, { status: 204 });
}
