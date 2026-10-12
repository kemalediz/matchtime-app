/**
 * TEST-ONLY ROUTE. It answers 404 unless the server was booted with
 * MT_TEST_MODE exactly "1", which nothing sets but e2e/helpers/env.ts.
 * In production it does not exist as far as any caller can tell.
 *
 * WHY IT EXISTS (review of PR #241, fix 9). `expandShortLink`
 * (src/lib/map-link.ts) relies on `fetch` honouring `redirect: "manual"`,
 * an abort signal and an unread body. Next.js PATCHES the global `fetch`
 * inside the server, so those have to be shown to hold HERE, in a real
 * route handler, and not only under plain Node. This route runs the
 * expander with the server's own patched `fetch` against a hostile HTTP
 * server the spec starts on this machine
 * (e2e/api/venue-short-link-real-fetch.spec.ts).
 *
 * It can reach nothing but 127.0.0.1 on the given port: the two short
 * hosts are remapped there by `remapShortHostsTo`, which refuses any
 * other URL, and everything else `expandShortLink` does is unchanged.
 */
import { NextResponse } from "next/server";
import { remapShortHostsTo } from "@/lib/geocode-test-seam";
import { expandShortLink } from "@/lib/map-link";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.MT_TEST_MODE !== "1") return new NextResponse(null, { status: 404 });

  const params = new URL(request.url).searchParams;
  const port = Number(params.get("port"));
  const path = params.get("path") ?? "";
  const timeoutMs = Number(params.get("timeoutMs")) || undefined;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^\/[A-Za-z0-9/_-]*$/.test(path)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const requested: string[] = [];
  const started = Date.now();
  // `fetch` here is the one Next patches: that is the point.
  const result = await expandShortLink(new URL(`https://maps.app.goo.gl${path}`), {
    fetchImpl: remapShortHostsTo(port, fetch, requested),
    timeoutMs,
  });
  return NextResponse.json({ result, requested, ms: Date.now() - started });
}
