/**
 * POST /api/play/visit: the /play page's funnel beacon (visits 2026-11-03,
 * steps 2026-11-04). Public, as the rest of /api/play/. Answers 204 at once,
 * whatever it is sent, and counts AFTER the answer (`after`), so it never
 * slows the page.
 *
 * Body: `{ src, ref, step }`, `src` and `ref` as the page's own URL carried
 * them, read exactly as the page reads them (`readSignupSource`). `step` is
 * "opened" (or missing) or "started", the two only the browser sees; "sent"
 * and "confirmed" are counted by the server where they happen, so a body
 * naming them counts nothing (`readPoolPageStep`). The user agent decides
 * only whether this is a link preview fetcher (`recordPoolVisit`), and is
 * never stored.
 */
import { after } from "next/server";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { readPoolPageStep } from "@/lib/pool/visit-rules";
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
  const step = readPoolPageStep(body.step);
  if (!step) return new Response(null, { status: 204 });
  const source = readSignupSource(body);
  const userAgent = request.headers.get("user-agent");
  const now = new Date();
  after(() => recordPoolVisit({ source, userAgent, now, step }));
  return new Response(null, { status: 204 });
}
