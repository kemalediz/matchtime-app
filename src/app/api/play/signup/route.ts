/**
 * POST /api/play/signup: the /play form's submit (local player pool, slice
 * L2). Public: a visitor has no session. A route rather than a server
 * action so the sandboxed WhatsApp scenarios (e2e/sim/pool) sign up through
 * the very code the page uses.
 *
 * Validates (lib/pool/profile-fields.ts), writes ONE waiting profile
 * (lib/pool/signup.ts) and answers with the code and the wa.me link that
 * opens WhatsApp with the confirm message, plus the status token the /play
 * reminder asks with (`signup-status-token.ts`). Nothing is live, and nobody is
 * messaged, until the person sends that message himself.
 *
 * THE MATCHTIME NUMBER. This answer carries it inside the wa.me link, as the
 * self-join connect action's does (`src/lib/__tests__/wa-number-server-only
 * .test.ts` names both): only after a valid, rate-limited sign-up, never in
 * the page, a bundle or the sitemap. A stranger has to be able to write to
 * MatchTime; that is the whole point of the pool's WhatsApp-first sign-up.
 */
import { NextResponse } from "next/server";
import { poolRequestIp } from "@/lib/pool/request-ip";
import { matchtimeWaNumber } from "@/lib/club-connect";
import { waMeLink } from "@/lib/club-connect-rules";
import { poolConfirmPrefill } from "@/lib/pool/confirm-rules";
import { isPoolSignupPaused } from "@/lib/pool/flags";
import { poolOpenForApiRequest } from "@/lib/pool/flags-request";
import { readSignupSource, validatePoolSignup } from "@/lib/pool/profile-fields";
import { createPoolSignup } from "@/lib/pool/signup";
import { poolSignupStatusToken } from "@/lib/pool/signup-status-token";
import { openFriendLink } from "@/lib/friend-link/page";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  // A friend link still works while sign-ups are paused (friend link D5).
  if (isPoolSignupPaused() && !(body && typeof body === "object" && body.friendToken !== undefined)) {
    return NextResponse.json({ ok: false, reason: "paused" }, { status: 503 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });

  const valid = validatePoolSignup(body);
  if (!valid.ok) return NextResponse.json({ ok: false, reason: "invalid", errors: valid.errors }, { status: 400 });

  const number = matchtimeWaNumber();
  if (!number) return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });

  const source = readSignupSource((body.source ?? {}) as Record<string, unknown>);
  // A friend link (2026-10-31): only while it is still usable, decided by
  // the same reading the page shows (`openFriendLink`).
  let friendLink: { id: string; issuedByUserId: string; kickoff: Date } | undefined;
  if (body.friendToken !== undefined) {
    const opened = typeof body.friendToken === "string" ? await openFriendLink(body.friendToken) : null;
    if (!opened || opened.state !== "open") return NextResponse.json({ ok: false, reason: "link-closed" }, { status: 409 });
    friendLink = { id: opened.id, issuedByUserId: opened.issuedByUserId, kickoff: opened.facts.kickoff };
  }
  const res = await createPoolSignup({
    fields: valid.value,
    ip: poolRequestIp(request),
    source,
    earlyList: !(await poolOpenForApiRequest(request)),
    friendLink,
  });
  if (!res.ok) {
    const status = res.reason === "busy" ? 429 : 422;
    return NextResponse.json({ ok: false, reason: res.reason }, { status });
  }

  const prefill = poolConfirmPrefill(valid.value.language, res.code);
  return NextResponse.json({
    ok: true,
    code: res.code,
    prefill,
    waLink: waMeLink(number, prefill),
    earlyList: res.earlyList,
    // For the /play reminder (signup-status-token.ts): only this browser's
    // own sign-up can be asked about, and only "waiting", "done" or "gone".
    statusToken: poolSignupStatusToken(res.id, res.code),
    expiresAt: res.expiresAt.toISOString(),
  });
}
