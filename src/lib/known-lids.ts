/**
 * Every LID this org's own records tie to a phone or a member
 * (2026-09-30): the participant snapshots taken when MatchTime joined the
 * group (`OnboardingSession`, `ClubConnect`) and the organiser's connect
 * DM (`ClubConnect.dmLid`). The server stores no other LID.
 *
 * Moved here from `api/whatsapp/analyze/route.ts` on 2026-11-09 so the
 * mention naming there and "@Match Time DM these people"
 * (`recruit.ts` `inviteNamedPeople`) read the same pairs.
 */
import { db } from "./db";
import { parseParticipantSnapshot } from "./participant-snapshot";
import type { KnownLid } from "./pipeline/mention-names";

export async function loadKnownLids(orgId: string): Promise<KnownLid[]> {
  const [sessions, connects] = await Promise.all([
    db.onboardingSession.findMany({ where: { orgId }, select: { participants: true } }),
    db.clubConnect.findMany({
      where: { orgId },
      select: { userId: true, dmLid: true, participants: true },
    }),
  ]);
  const out: KnownLid[] = [];
  for (const row of [...sessions, ...connects]) {
    for (const p of parseParticipantSnapshot(row.participants)) {
      if (p.lidId && p.phone) out.push({ lid: p.lidId, phone: p.phone });
    }
  }
  for (const c of connects) {
    if (c.dmLid) out.push({ lid: c.dmLid, userId: c.userId });
  }
  return out;
}
