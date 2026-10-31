/**
 * THE /play REMINDER'S STATUS CHECK, the PURE rules (2026-10-31). No
 * database, no clock of its own.
 *
 * A browser that signed up remembers its code (`pending-signup.ts`) and, on a
 * later visit, asks whether the sign-up still waits for that code. Three
 * answers, nothing else:
 *   waiting  still "pending-verify", this code, not run out: show the reminder
 *   done     confirmed on WhatsApp (the code is cleared then): forget it
 *   gone     deleted, run out, or not ours: forget it
 */
import { POOL_SIGNUP_STATUS } from "./rules";

export const POOL_SIGNUP_STATES = ["waiting", "done", "gone"] as const;
export type PoolSignupState = (typeof POOL_SIGNUP_STATES)[number];

export function poolSignupState(
  row: { status: string; confirmCode: string | null; confirmCodeExpiresAt: Date | null } | null,
  code: string,
  now: Date,
): PoolSignupState {
  if (!row) return "gone";
  if (row.status !== "pending-verify") return "done";
  if (row.confirmCode !== code || !row.confirmCodeExpiresAt || row.confirmCodeExpiresAt.getTime() <= now.getTime()) return "gone";
  return "waiting";
}

const HOUR_MS = 3600_000;

/** One more check from an address that made `hits` (times, ms): allowed
 *  while fewer than the cap fall in the last hour. The hits to keep. */
export function takeStatusCheck(hits: readonly number[], nowMs: number, cap: number = POOL_SIGNUP_STATUS.perIpPerHour): { ok: boolean; hits: number[] } {
  const recent = hits.filter((t) => t > nowMs - HOUR_MS);
  if (recent.length >= cap) return { ok: false, hits: recent };
  return { ok: true, hits: [...recent, nowMs] };
}
