/**
 * Resolve a short magic-link code → its full token, for the /r landing
 * page (which is a client component and can't read the DB directly).
 *
 * Public by design: the code IS the secret (like the token it stands in
 * for). Returns only the token; the magic-link provider still verifies it
 * on sign-in, so a leaked or old code can't do more than the underlying
 * token already allowed.
 *
 * THREE ANSWERS (security review of PR #248):
 *
 *   200 { token }                         the code's token still signs in.
 *   410 { error: "expired" }              a link of OURS (good signature)
 *       whose expiry has passed. Nothing else is said: not the page it was
 *       for, not its club, not the club's language, not the person. The
 *       /r page then sends its holder to /login with the link itself, and
 *       the server reads it only after they have signed in
 *       (src/lib/expired-link.ts). A long token put where the code goes
 *       gets the same answer, which is how the /r page asks about one.
 *   404 { error: "not-found-or-expired" } everything else: an unknown
 *       code, a forged token, and a token that is still inside its expiry
 *       but REFUSED BY THE LIFETIME POLICY (minted for longer than its
 *       purpose allows, or a legacy token past the sunset). Such a token
 *       is not "expired", so its holder gets the plain "This link isn't
 *       valid" card, not the sign-in notice. A live long token put where
 *       the code goes is 404 as well: there is nothing to resolve.
 *
 * The token decides, not the row's own `expiresAt`: a row can outlive its
 * token, and a token that cannot sign anybody in must never be handed out.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isLinkHandle } from "@/lib/expired-link";
import { readExpiredMagicLink, verifyMagicLinkToken } from "@/lib/magic-link";

const NOT_FOUND = { error: "not-found-or-expired" } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  if (!isLinkHandle(code)) return NextResponse.json(NOT_FOUND, { status: 404 });

  const isToken = code.includes(".");
  let token: string | null = isToken ? code : null;
  if (!isToken) {
    try {
      token = (await db.shortLink.findUnique({ where: { code }, select: { token: true } }))?.token ?? null;
    } catch {
      token = null;
    }
  }
  if (!token) return NextResponse.json(NOT_FOUND, { status: 404 });

  if (readExpiredMagicLink(token)) return NextResponse.json({ error: "expired" }, { status: 410 });
  // The same purposes the sign-in provider honours (src/lib/auth.ts).
  if (!isToken && (await verifyMagicLinkToken(token, { purposes: ["sign-in", "rate-match"] }))) {
    return NextResponse.json({ token });
  }
  return NextResponse.json(NOT_FOUND, { status: 404 });
}
