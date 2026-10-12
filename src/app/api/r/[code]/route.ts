/**
 * Resolve a short magic-link code → its full token, for the /r landing
 * page (which is a client component and can't read the DB directly).
 *
 * Public by design: the code IS the secret (like the token it stands in
 * for). Returns only the token; the magic-link provider still
 * verifies + expiry-checks it on sign-in, so a leaked/old code can't do
 * more than the underlying token already allowed.
 *
 * AN EXPIRED LINK (2026-10) answers 410 with where it was going and the
 * language to say so in, so the /r page can send its holder to sign in
 * and carry on, instead of to a dead end (src/lib/expired-link.ts). It
 * names nobody and signs nobody in. The same holds for a long token put
 * where the code goes, which is how the /r page asks about one. Anything
 * else is still 404.
 */
import { NextResponse } from "next/server";
import { resolveShortLink } from "@/lib/short-link";
import { expiredLinkInfo, expiredLoginPath } from "@/lib/expired-link";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  // A long token is never a short code.
  const token = code.includes(".") ? null : await resolveShortLink(code);
  // Asked of the TOKEN when the code still resolves: a row can outlive its
  // token, and a token that cannot sign anybody in is "expired" too. For a
  // token that still works this reads nothing from the database.
  const expired = await expiredLinkInfo(token ?? code);
  if (expired) {
    return NextResponse.json({ error: "expired", login: expiredLoginPath(expired) }, { status: 410 });
  }
  if (!token) return NextResponse.json({ error: "not-found-or-expired" }, { status: 404 });
  return NextResponse.json({ token });
}
