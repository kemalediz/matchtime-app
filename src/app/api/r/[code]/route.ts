/**
 * Resolve a short magic-link code → its full token, for the /r landing
 * page (which is a client component and can't read the DB directly).
 *
 * Public by design: the code IS the secret (like the token it stands in
 * for). Returns only the token; the magic-link provider still
 * verifies + expiry-checks it on sign-in, so a leaked/old code can't do
 * more than the underlying token already allowed.
 */
import { NextResponse } from "next/server";
import { resolveShortLink } from "@/lib/short-link";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const token = await resolveShortLink(code);
  if (!token) {
    return NextResponse.json({ error: "not-found-or-expired" }, { status: 404 });
  }
  return NextResponse.json({ token });
}
