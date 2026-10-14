/**
 * THE CLUB'S OWN POSTER BACKGROUND (2026-10-14).
 *
 *   POST   /api/org/graphics/background   multipart/form-data, field "file"
 *   DELETE /api/org/graphics/background
 *
 * Owner or admin of the club only (403 otherwise). POST checks the picture
 * (`graphics-background.ts`: JPEG, PNG or WebP by its bytes, at most 4 MB,
 * portrait, big enough), stores it re-encoded as the club's own design and
 * picks it. DELETE removes it; the club is back on the default. Neither
 * touches a design MatchTime made for the club (409).
 *
 * Answers: { ok: true } or { ok: false, problem } with
 *   400 empty | bad-type | bad-bytes | too-small | not-portrait
 *   413 too-large
 *   409 made-by-matchtime
 *   404 none (DELETE with nothing to remove)
 *   503 failed (the database could not take it)
 */
import { NextResponse } from "next/server";
import { clubGraphicsAccess } from "@/lib/club-graphics-access";
import { removeClubBackground, saveClubBackground } from "@/lib/club-graphics-store";
import { BACKGROUND_MAX_BYTES } from "@/lib/graphics-background";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  "too-large": 413,
  "made-by-matchtime": 409,
  none: 404,
  failed: 503,
};

const answer = (problem: string) => NextResponse.json({ ok: false, problem }, { status: STATUS[problem] ?? 400 });

export async function POST(req: Request) {
  const access = await clubGraphicsAccess();
  if (!access.ok) return NextResponse.json({ ok: false, problem: "not-allowed" }, { status: access.status });

  // Refuse an oversized body before reading it, when the client says its size.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > BACKGROUND_MAX_BYTES + 64 * 1024) return answer("too-large");

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return answer("empty");
  }
  if (!file || file.size === 0) return answer("empty");
  if (file.size > BACKGROUND_MAX_BYTES) return answer("too-large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await saveClubBackground(access.orgId, bytes, file.type || null, access.userId);
  return r.ok ? NextResponse.json({ ok: true }) : answer(r.problem);
}

export async function DELETE() {
  const access = await clubGraphicsAccess();
  if (!access.ok) return NextResponse.json({ ok: false, problem: "not-allowed" }, { status: access.status });
  const r = await removeClubBackground(access.orgId);
  return r.ok ? NextResponse.json({ ok: true }) : answer(r.error);
}
