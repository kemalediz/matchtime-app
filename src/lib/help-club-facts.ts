/**
 * WHAT THE HELP NEEDS TO KNOW ABOUT A CLUB BEYOND ITS FEATURE FLAGS
 * (2026-10-28): whether the player pool is open for it and whether it has
 * partner clubs it asks. Read only when a help answer is written, so it
 * costs nothing on any other message.
 *
 *   pool       THE ONE RULE (`pool/flags.ts` `poolOpenForClub`): the
 *              platform switch, as this call resolved it (`pool/switch-env.ts`),
 *              AND the club's own `featurePlayerPool`. Both halves are carried
 *              too, so an organiser is told which of the two is off.
 *   partners   the club's ACTIVE partnerships in which it asks
 *              (`ClubPartnership.askerOrgId`, status "active"): the pairing
 *              is the switch (Kemal, 2026-11-08; `canAsk`).
 *
 * A read that fails reads as off: the help then says how to switch it on,
 * which is never a false promise.
 */
import { db } from "./db";
import { isPoolOffersEnabled, poolOpenForClub } from "./pool/flags";

type Env = Record<string, string | undefined>;

export interface HelpClubFacts {
  pool: { open: boolean; platformOpen: boolean; clubFlag: boolean };
  partners: { active: number };
}

export const HELP_CLUB_FACTS_OFF: HelpClubFacts = {
  pool: { open: false, platformOpen: false, clubFlag: false },
  partners: { active: 0 },
};

export async function loadHelpClubFacts(orgId: string, env: Env): Promise<HelpClubFacts> {
  try {
    const [org, active] = await Promise.all([
      db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true } }),
      db.clubPartnership.count({ where: { askerOrgId: orgId, status: "active" } }),
    ]);
    const platformOpen = isPoolOffersEnabled(env);
    return {
      pool: { open: poolOpenForClub(org, platformOpen), platformOpen, clubFlag: org?.featurePlayerPool === true },
      partners: { active },
    };
  } catch (err) {
    console.error(`[help] club facts for ${orgId} unread:`, err instanceof Error ? err.message : "failed");
    return HELP_CLUB_FACTS_OFF;
  }
}
