/**
 * POST /api/play/signup: the /play form's submit (local player pool, slice
 * L2). Public: a visitor has no session. A route rather than a server
 * action so the sandboxed WhatsApp scenarios (e2e/sim/pool) sign up through
 * the very code the page uses.
 *
 * Validates (lib/pool/profile-fields.ts), writes ONE waiting profile
 * (lib/pool/signup.ts) and answers with the code and the wa.me link that
 * opens WhatsApp with the confirm message. Nothing is live, and nobody is
 * messaged, until the person sends that message himself.
 *
 * THE MATCHTIME NUMBER. This answer carries it inside the wa.me link, as the
 * self-join connect action's does (`src/lib/__tests__/wa-number-server-only
 * .test.ts` names both): only after a valid, rate-limited sign-up, never in
 * the page, a bundle or the sitemap. A stranger has to be able to write to
 * MatchTime; that is the whole point of the pool's WhatsApp-first sign-up.
 */
import { NextResponse } from "next/server";
import { matchtimeWaNumber } from "@/lib/club-connect";
import { waMeLink } from "@/lib/club-connect-rules";
import { poolConfirmPrefill } from "@/lib/pool/confirm-rules";
import { isPoolSignupPaused } from "@/lib/pool/flags";
import { poolOpenForApiRequest } from "@/lib/pool/flags-request";
import { readSignupSource, validatePoolSignup } from "@/lib/pool/profile-fields";
import { createPoolSignup } from "@/lib/pool/signup";

function requestIp(request: Request): string | null {
  const first = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
  const ip = first || (request.headers.get("x-real-ip") ?? "").trim();
  return ip ? ip.slice(0, 64) : null;
}

export async function POST(request: Request) {
  if (isPoolSignupPaused()) return NextResponse.json({ ok: false, reason: "paused" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });

  const valid = validatePoolSignup(body);
  if (!valid.ok) return NextResponse.json({ ok: false, reason: "invalid", errors: valid.errors }, { status: 400 });

  const number = matchtimeWaNumber();
  if (!number) return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });

  const source = readSignupSource((body.source ?? {}) as Record<string, unknown>);
  const res = await createPoolSignup({
    fields: valid.value,
    ip: requestIp(request),
    source,
    earlyList: !(await poolOpenForApiRequest(request)),
  });
  if (!res.ok) {
    const status = res.reason === "busy" ? 429 : 422;
    return NextResponse.json({ ok: false, reason: res.reason }, { status });
  }

  const prefill = poolConfirmPrefill(valid.value.language, res.code);
  return NextResponse.json({ ok: true, code: res.code, prefill, waLink: waMeLink(number, prefill), earlyList: res.earlyList });
}
