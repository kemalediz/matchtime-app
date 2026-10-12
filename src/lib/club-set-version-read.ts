/**
 * READING THE CLUB SET VERSION FOR A RESPONSE (PR #250 review, fix 1).
 *
 * The stamp is a convenience on two responses the Pi cannot do without:
 * its every-tick poll for platform jobs, and /orgs. So the read may never
 * cost either of them anything:
 *
 *   - it never throws: a failure is "no stamp this time";
 *   - it never waits long: after `CLUB_SET_VERSION_TIMEOUT_MS` the caller
 *     carries on without it. A try/catch covers a throw, not a stall, and a
 *     query that hangs until the function is killed would take the whole
 *     response with it;
 *   - the routes call it BEFORE they claim or read anything else, so
 *     nothing already claimed is ever waiting on it (platform jobs are
 *     claimed as they are handed out, and nothing reclaims one).
 *
 * Without the field the Pi compares nothing on that poll, exactly as with
 * an older server, and its five-minute refresh is unchanged.
 */
import { loadClubSetVersion } from "./club-set-version";

/** How long a response waits for the stamp. The query itself takes about a millisecond. */
export const CLUB_SET_VERSION_TIMEOUT_MS = 1_500;

/** The stamp, or null when it failed or did not come in time. Never throws. */
export async function readClubSetVersion(tag: string, timeoutMs: number = CLUB_SET_VERSION_TIMEOUT_MS): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    });
    const read = loadClubSetVersion().then(
      (v) => v,
      (err: unknown) => {
        console.error(`[${tag}] club set version could not be read; none sent this time: ${(err as Error)?.name ?? "error"}`);
        return null;
      },
    );
    const out = await Promise.race([read, timeout]);
    if (out === "timed-out") {
      console.error(`[${tag}] club set version not read within ${timeoutMs} ms; none sent this time`);
      return null;
    }
    return typeof out === "string" && out.length > 0 ? out : null;
  } catch (err) {
    console.error(`[${tag}] club set version could not be read; none sent this time: ${(err as Error)?.name ?? "error"}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
