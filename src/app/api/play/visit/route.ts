/**
 * POST /api/play/visit: the /play page's visit beacon (2026-11-03). Public,
 * as the rest of /api/play/. Answers 204 at once, whatever it is sent, and
 * counts the visit AFTER the answer (`after`), so it never slows the page.
 *
 * Body: `{ src, ref }` as the page's own URL carried them, read exactly as
 * the page reads them (`readSignupSource`). The user agent decides only
 * whether this is a link preview fetcher (`recordPoolVisit`), and is never
 * stored.
 */
import { after } from "next/server";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { recordPoolVisit } from "@/lib/pool/visits";

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: plain /play.
  }
  const source = readSignupSource(body);
  const userAgent = request.headers.get("user-agent");
  const now = new Date();
  after(() => recordPoolVisit({ source, userAgent, now }));
  return new Response(null, { status: 204 });
}
