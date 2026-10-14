/**
 * PICTURE READING (2026-10-14). The Pi asks before it downloads a picture
 * posted in a club's group, then sends the picture to be read.
 *
 *   POST { mode: "check", groupId, waMessageId, senderPhone?, senderAltPhone?,
 *          senderLid?, caption? }
 *     -> { read: true, why } | { read: false, reason }
 *   POST { mode: "read", ...the same, image: { data: <base64>, mediaType } }
 *     -> { read: true, transcript: string | null } | { read: false, reason }
 *
 * `transcript` null means the picture was read and is not about the game.
 * The rules and the caps are in lib/picture-reading.ts. Behind
 * PICTURE_READING_ENABLED (off: every answer is "flag-off").
 *
 * The picture lives only in this request's memory: it is not stored, not
 * logged, and not passed anywhere but the one model call. Auth via
 * WHATSAPP_API_KEY, like the rest of /api/whatsapp/*.
 *
 * TEST SEAMS, honoured only with MT_TEST_MODE=1: `x-mt-test-picture-reading`
 * (the flag), `x-test-now` (the clock) and `x-mt-test-picture-stub` (the
 * text the model "returns", put behind the club's AI budget like the real
 * one, so the e2e suite runs the whole path with no model call).
 */
import { NextResponse } from "next/server";
import { checkPicture, readPicture } from "@/lib/picture-reading";
import { prismaPictureDeps } from "@/lib/picture-reading-db";
import { pictureReadingEnabledForApiRequest } from "@/lib/picture-reading-flag";
import { budgetedModel, type PipelineModel } from "@/lib/pipeline/llm";

const PICTURE_STUB_HEADER = "x-mt-test-picture-stub";
/** The picture is base64 in the body; this bounds the whole request. */
const MAX_BODY_CHARS = 6_000_000;

function testSeam(request: Request): { now?: Date; model?: PipelineModel } {
  if (process.env.MT_TEST_MODE !== "1") return {};
  const out: { now?: Date; model?: PipelineModel } = {};
  const pinned = new Date(request.headers.get("x-test-now") ?? "");
  if (!Number.isNaN(pinned.getTime())) out.now = pinned;
  const stub = request.headers.get(PICTURE_STUB_HEADER);
  if (stub !== null) {
    out.model = budgetedModel({
      name: "picture-stub",
      complete: async () => ({
        text: stub,
        stopReason: "end_turn",
        usage: { inputTokens: 2_200, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0042,
        ms: 1,
      }),
    });
  }
  return out;
}

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ read: false, reason: "bad-image" }, { status: 413 });
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || (body.mode !== "check" && body.mode !== "read")) {
    return NextResponse.json({ error: "mode check or read required" }, { status: 400 });
  }
  const seam = testSeam(request);
  const opts = {
    enabled: pictureReadingEnabledForApiRequest(request),
    now: seam.now ?? new Date(),
    deps: prismaPictureDeps(seam.model),
  };
  const meta = {
    groupId: typeof body.groupId === "string" ? body.groupId : "",
    waMessageId: typeof body.waMessageId === "string" ? body.waMessageId : "",
    senderPhone: typeof body.senderPhone === "string" ? body.senderPhone : null,
    senderAltPhone: typeof body.senderAltPhone === "string" ? body.senderAltPhone : null,
    senderLid: typeof body.senderLid === "string" ? body.senderLid : null,
    caption: typeof body.caption === "string" ? body.caption : null,
  };
  if (body.mode === "check") {
    const r = await checkPicture(meta, opts);
    return NextResponse.json(r.read ? { read: true, why: r.why } : { read: false, reason: r.reason });
  }
  const r = await readPicture({ ...meta, image: body.image }, opts);
  return NextResponse.json(r.read ? { read: true, transcript: r.transcript } : { read: false, reason: r.reason });
}
