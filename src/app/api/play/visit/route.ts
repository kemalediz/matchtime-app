/**
 * POST /api/play/visit: the /play page's funnel beacon (visits 2026-11-03,
 * steps 2026-11-04). Public, as the rest of /api/play/. Answers 204 at once,
 * whatever it is sent, and counts AFTER the answer (`after`), so it never
 * slows the page.
 *
 * Body: `{ src, ref, step, trigger }`, `src` and `ref` as the page's own URL
 * carried them, read exactly as the page reads them (`readSignupSource`).
 * Only a beacon the page sends counts (`readPoolPageBeacon`, 2026-11-16):
 * "opened" (or no step) with what a person did, a tap, touch, key, wheel or
 * scroll, or a start first; "started" as ever. An open by time on screen,
 * or with no trigger, counts nothing: on 15 November 2026 the 4 counted
 * opens were scanners that waited 5 seconds. The trigger is read only to
 * tell the two apart: it is never passed on, stored or logged (round 2 of
 * #607: a wheel or key comes first only from a computer). "sent" and "confirmed" are
 * counted by the server where they happen, so a body naming them counts
 * nothing. Anything else in the body (a time on screen from a page cached
 * before 2026-11-16) is ignored. The user agent decides whether this is a
 * link preview fetcher (`recordPoolVisit`); it is never stored or logged:
 * the daily breakdown and the one log line per beacon keep only the
 * in-app browser and the scanner flag read off it (2026-11-16). A beacon
 * that counts nothing is logged in one short line, its step and why. No
 * address, cookie or user id is passed on.
 *
 * OUR OWN STAFF (2026-11-12; MatchTime staff only since 2026-11-16): a
 * beacon carrying the staff cookie, or a session for a `User.isSuperadmin`
 * account, gets the same 204 and counts nothing (`isPoolStaffRequest`). A
 * club's owner or admin is not staff, and the cookie every organiser got
 * until 2026-11-16 ("1") no longer counts as staff, signed in or not. The
 * session is looked up after the answer, and only when there is no current
 * cookie; a lookup that fails counts the visit.
 */
import { after } from "next/server";
import { cookies } from "next/headers";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { POOL_STAFF_COOKIE } from "@/lib/pool/visit-rules";
import { poolBeaconRejectedLogLine, readPoolPageBeacon } from "@/lib/pool/visit-log-rules";
import { isPoolStaffRequest } from "@/lib/pool/staff-request";
import { recordPoolVisit } from "@/lib/pool/visits";

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: not a beacon the page sends.
  }
  const read = body ? readPoolPageBeacon(body) : ({ ok: false, step: "other", reason: "not-json" } as const);
  if (!read.ok) {
    // One short line, so a page or scanner sending the wrong thing can be
    // diagnosed: the step (only if it is one of ours) and why, nothing it sent.
    console.info(poolBeaconRejectedLogLine({ step: read.step, reason: read.reason }));
    return new Response(null, { status: 204 });
  }
  const beacon = read.beacon;
  const source = readSignupSource(body ?? {});
  const userAgent = request.headers.get("user-agent");
  const now = new Date();
  const staffCookie = (await cookies()).get(POOL_STAFF_COOKIE)?.value ?? null;
  after(async () => {
    if (await isPoolStaffRequest(staffCookie)) {
      console.info(`[pool-funnel] skipped staff visit step=${beacon.step}`);
      return;
    }
    await recordPoolVisit({ source, userAgent, now, step: beacon.step });
  });
  return new Response(null, { status: 204 });
}
