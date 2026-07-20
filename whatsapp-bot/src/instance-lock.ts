/**
 * Single-instance guard for the WhatsApp bot.
 *
 * 2026-07-19 incident: a group got 30+ copies of one roster post because
 * SEVERAL bot processes were alive on the Pi at once. Repeated
 * `systemctl restart` had left processes running outside systemd's
 * cgroup (systemd's MainPID tracked only one of two `sh -c node …
 * src/index.ts` trees), and every orphan kept polling due-posts and
 * sending. The server-side claim (src/lib/dispatch-claim.ts) now makes
 * duplicate SENDS impossible; this guard stops duplicate PROCESSES from
 * existing in the first place, which is the actual bug.
 *
 * Mechanism: a pidfile whose PID is verified alive. We deliberately do
 * NOT depend on an external `flock` binary (not guaranteed on the Pi
 * image) — a written-then-verified pidfile plus liveness probing gives
 * the same guarantee for our single-host case, and it self-heals after a
 * power cut / SIGKILL, where a plain "does the file exist?" check would
 * wedge the bot permanently.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export const DEFAULT_LOCK_PATH = "/tmp/matchtime-bot.pid";

export type LockAction =
  | { action: "acquire" }
  | { action: "steal-stale"; holderPid: number }
  | { action: "abort"; holderPid: number };

/**
 * Pure decision: given what the lockfile says and whether that PID is
 * alive, what should we do?
 *
 * - no lockfile                  → acquire
 * - lockfile holds OUR pid       → acquire (re-entrant / rewritten lock)
 * - lockfile pid dead or garbage → steal (self-heals after SIGKILL)
 * - lockfile pid alive           → abort, another bot owns this account
 */
export function decideLockAction(input: {
  existing: { pid: number } | null;
  selfPid: number;
  isAlive: (pid: number) => boolean;
}): LockAction {
  const { existing, selfPid, isAlive } = input;
  if (!existing) return { action: "acquire" };
  const { pid } = existing;
  if (!Number.isFinite(pid) || pid <= 0) return { action: "steal-stale", holderPid: pid };
  if (pid === selfPid) return { action: "acquire" };
  return isAlive(pid) ? { action: "abort", holderPid: pid } : { action: "steal-stale", holderPid: pid };
}

/**
 * Exit code to use when another live instance owns the lock.
 *
 * CRITICAL detail: the systemd unit has `Restart=on-failure`. Exiting
 * NON-ZERO here would make systemd respawn us immediately, we'd hit the
 * live lock again, exit non-zero again … an endless crash-restart loop
 * that burns the Pi's CPU and floods the journal for as long as the other
 * instance lives. So under systemd (which always sets INVOCATION_ID) we
 * exit 0: a clean exit is NOT a failure, so `Restart=on-failure` leaves
 * us stopped, the already-running bot keeps serving, and the CRITICAL log
 * line records why. Run by hand (no INVOCATION_ID) we exit 1 so a human —
 * or a script — sees the failure loudly.
 *
 * This is the fail-safe choice: "the bot is already running" is a
 * success condition for the system as a whole, not a crash.
 */
export function lockExitCode(input: { underSystemd: boolean }): number {
  return input.underSystemd ? 0 : 1;
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without signalling.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): { pid: number } | null {
  if (!existsSync(path)) return null;
  try {
    return { pid: parseInt(readFileSync(path, "utf8").trim(), 10) };
  } catch {
    return { pid: NaN }; // unreadable → treat as stale, not as a permanent block
  }
}

export interface AcquireResult {
  acquired: boolean;
  holderPid?: number;
  exitCode: number;
}

/**
 * Try to become THE bot instance. On success, registers cleanup handlers
 * that remove the lockfile on normal exit / SIGINT / SIGTERM.
 */
export function acquireInstanceLock(
  opts: { path?: string; selfPid?: number; underSystemd?: boolean } = {},
): AcquireResult {
  const path = opts.path ?? process.env.MT_BOT_LOCK_PATH ?? DEFAULT_LOCK_PATH;
  const selfPid = opts.selfPid ?? process.pid;
  const underSystemd = opts.underSystemd ?? Boolean(process.env.INVOCATION_ID);

  const decision = decideLockAction({ existing: readLock(path), selfPid, isAlive: pidIsAlive });

  if (decision.action === "abort") {
    return { acquired: false, holderPid: decision.holderPid, exitCode: lockExitCode({ underSystemd }) };
  }

  if (decision.action === "steal-stale") {
    try {
      unlinkSync(path);
    } catch {
      /* already gone — fine */
    }
  }

  try {
    // `wx` fails if the file reappeared between our check and this write —
    // that means another instance won the race, so we stand down.
    writeFileSync(path, String(selfPid), { flag: "wx" });
  } catch {
    const raced = readLock(path);
    if (raced && raced.pid !== selfPid && Number.isFinite(raced.pid) && pidIsAlive(raced.pid)) {
      return { acquired: false, holderPid: raced.pid, exitCode: lockExitCode({ underSystemd }) };
    }
    // Same pid or a dead holder: overwrite and continue.
    try {
      writeFileSync(path, String(selfPid));
    } catch {
      /* best effort — never block startup on a lockfile write failure */
    }
  }

  const release = () => {
    try {
      const current = readLock(path);
      if (current && current.pid === selfPid) unlinkSync(path);
    } catch {
      /* best effort */
    }
  };
  process.once("exit", release);
  process.once("SIGINT", release);
  process.once("SIGTERM", release);

  return { acquired: true, exitCode: 0 };
}
