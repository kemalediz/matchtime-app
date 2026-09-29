/**
 * The Pi's door to the PLATFORM CHANNEL (self-join slice 3, 2026-09-29):
 * DMs and actions that belong to no live club. Design and rules in
 * src/lib/platform-jobs.ts.
 *
 *   GET   Claim up to MAX_JOBS_PER_POLL due jobs and hand them over.
 *         Claim-on-dispatch, as due-posts: the job is marked claimed as it
 *         leaves, so a second poller (a duplicate Pi process) gets nothing
 *         for it. Response: { jobs: PlatformJobInstruction[] }.
 *
 *   POST  The outcome of one job:
 *           { id, outcome: "sent", waMessageId? }
 *           { id, outcome: "failed", error? }   never recorded as sent
 *           { id, outcome: "release" }          the Pi's DM pacing held it
 *
 * Polled once per scheduler tick by a Pi built with slice 3, whatever the
 * clubs' bot switches say. A Pi built before it never calls this; due-posts
 * bridges platform DMs to that Pi instead (see due-posts/route.ts).
 */
import { NextResponse } from "next/server";
import { claimDuePlatformJobs, recordPlatformJobOutcome, type PlatformJobOutcome } from "@/lib/platform-jobs";

function authorised(request: Request): boolean {
  return request.headers.get("x-api-key") === process.env.WHATSAPP_API_KEY;
}

export async function GET(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const jobs = await claimDuePlatformJobs();
  if (jobs.length > 0) {
    console.log(`[platform-jobs] handed out ${jobs.length}: ${jobs.map((j) => `${j.kind}:${j.id}`).join(", ")}`);
  }
  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { id?: unknown; outcome?: unknown; waMessageId?: unknown; error?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let outcome: PlatformJobOutcome;
  switch (body.outcome) {
    case "sent":
      outcome =
        typeof body.waMessageId === "string" && body.waMessageId
          ? { outcome: "sent", waMessageId: body.waMessageId }
          : { outcome: "sent" };
      break;
    case "failed":
      outcome = {
        outcome: "failed",
        reason: typeof body.error === "string" && body.error.trim() ? body.error : "no reason given by the Pi",
      };
      break;
    case "release":
      outcome = { outcome: "release" };
      break;
    default:
      return NextResponse.json({ error: 'outcome must be "sent", "failed" or "release"' }, { status: 400 });
  }

  const { updated } = await recordPlatformJobOutcome(id, outcome);
  return NextResponse.json({ ok: true, updated });
}
