/**
 * POST /api/play/signup/status (2026-10-31): the /play reminder's check.
 * Public, like the sign-up: the visitor has no session.
 *
 * Takes {token, code} (both from this browser's own sign-up answer) and
 * answers {state: "waiting" | "done" | "gone"} and NOTHING else: no name, no
 * id, no number. A guessed or broken request answers "gone", the same as a
 * deleted sign-up. Over the per-address cap (rules.ts POOL_SIGNUP_STATUS) it
 * answers 429 with no state. See `src/lib/pool/signup-status.ts`.
 */
import { NextResponse } from "next/server";
import { poolRequestIp } from "@/lib/pool/request-ip";
import { checkPoolSignupStatus } from "@/lib/pool/signup-status";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const ok = !!body && typeof body === "object" && !Array.isArray(body);
  const res = await checkPoolSignupStatus({ token: ok ? body.token : null, code: ok ? body.code : null, ip: poolRequestIp(request) });
  if (!res.ok) return NextResponse.json({ reason: "busy" }, { status: 429 });
  return NextResponse.json({ state: res.state });
}
