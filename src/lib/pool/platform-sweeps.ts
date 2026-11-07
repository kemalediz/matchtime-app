/**
 * THE POOL'S SWEEPS, ONE HOME (WhatsApp Cloud API plan, PR C4, section
 * 5.5). Run by the Pi's platform poll (GET /api/whatsapp/platform-jobs)
 * and, while the Cloud API is on, by the per-minute Cloud dispatch sweep
 * (/api/cron/cloud-dispatch), so pool offers no longer depend on the Pi
 * being up. Both call this, so neither copies the other.
 *
 *   sweepPool                offers whose time ran out, asks that should
 *                            close, wave 1 an hour after the partners,
 *                            wave 2 (round.ts)
 *   sweepClubInvitations     the after-game question, invitations the club
 *                            never answered, invite code jobs that never
 *                            came back (club-invitation.ts)
 *   sweepPartnerPoolInvites  the one DM to a partner club's player after
 *                            he played for another club (partner-invite.ts)
 *
 * Each is safe to run from two pollers at once (claims by compare-and-set,
 * per-ask locks and unique markers), as the Pi's duplicate-process class
 * already required. Each runs on its own: one failing never stops the next
 * and nothing is thrown, so a sweep can never cost a poll its jobs.
 */
import { sweepPool } from "./round";
import { sweepClubInvitations } from "./club-invitation";
import { sweepPartnerPoolInvites } from "./partner-invite";

type Env = Record<string, string | undefined>;

export async function runPlatformPoolSweeps(now: Date, env: Env, label: string): Promise<void> {
  try {
    await sweepPool(now, env);
  } catch (err) {
    console.error(`[${label}] pool sweep failed; the next poll tries again:`, err);
  }
  try {
    await sweepClubInvitations(now, env);
  } catch (err) {
    console.error(`[${label}] club invitations sweep failed; the next poll tries again:`, err);
  }
  try {
    await sweepPartnerPoolInvites(now, env);
  } catch (err) {
    console.error(`[${label}] partner pool invites sweep failed; the next poll tries again:`, err);
  }
}
