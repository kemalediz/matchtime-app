/**
 * GET /api/play/venues?q=...: MatchTime's own geocoded pitches whose name
 * or address contains the words, for the /play form's "chosen pitches"
 * (local player pool, slice L2). Public, read-only, at most five, and no
 * paid lookup behind it: names and addresses of public places only.
 */
import { NextResponse } from "next/server";
import { searchPoolVenues } from "@/lib/pool/profile-store";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ venues: await searchPoolVenues(q) });
}
