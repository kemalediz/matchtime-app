/**
 * A LIST POSTER OR TEAM SHEET QUEUED FOR THE ADMIN GROUP (2026-10-14).
 *
 * It rides on an ordinary `admin-group` BotJob, so it shares that job's
 * whole path (the due-posts poll, the claim, the ack, `BotJob.sentAt`) and
 * needs no schema change. What makes it a graphic is `pollOptions`, which
 * nothing reads on any kind but "group-poll":
 *
 *   ["graphic:v1", <"list" | "teams">, <matchId>, <"asked" | "auto">]
 *
 * "asked": an admin typed the command, so it goes out at once, even
 * outside the admin group's posting hours. "auto": a scheduled trigger
 * (the final list, approved teams), which waits for those hours like
 * every other admin-group post.
 *
 * The image URL is signed when the job is EMITTED (`graphicUrl`), with the
 * real clock, not when it was queued: a job held overnight still reaches
 * the Pi with a fresh 15-minute link.
 */
import { appUrl } from "./app-url";
import { signGraphicToken, type GraphicTarget } from "./graphic-token";
import type { GraphicKind } from "./match-graphics-copy";

const TAG = "graphic:v1";

export interface GraphicJob {
  kind: GraphicKind;
  matchId: string;
  asked: boolean;
}

export function graphicJobOptions(job: GraphicJob): string[] {
  return [TAG, job.kind, job.matchId, job.asked ? "asked" : "auto"];
}

/** The graphic a BotJob's `pollOptions` carries, or null for any other job. */
export function readGraphicJob(options: readonly string[] | null | undefined): GraphicJob | null {
  if (!Array.isArray(options) || options[0] !== TAG) return null;
  const [, kind, matchId, how] = options;
  if (kind !== "list" && kind !== "teams") return null;
  if (typeof matchId !== "string" || !matchId) return null;
  return { kind, matchId, asked: how === "asked" };
}

/** An absolute, signed URL for the graphic, valid for `ttlSeconds` from now (real time). */
export function graphicUrl(target: GraphicTarget, ttlSeconds: number): string {
  return appUrl(`/api/graphics/${signGraphicToken({ ...target, ttlSeconds })}`);
}
