/**
 * Cross-club phone link: the database side. The rules, and why, are in
 * `cross-club-link-rules.ts`. The merge itself is `mergePlayersCore`,
 * the one merge in the codebase; this file only reads the facts the
 * rules need, runs the merge when they allow it, and tags the merge's
 * `UserMerge` tombstone with who did it (the audit row).
 *
 * Both functions take a client `tx` so the link action can run the
 * read, the decision and the merge in ONE transaction: the facts the
 * admin confirmed against cannot change between the check and the write.
 */
// Same loose typing as merge-players-core.ts: the transaction client's
// type changes shape under `$extends` (see src/lib/db.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxClient = any;

import { mergePlayersCore } from "./merge-players-core";
import { hasOwnSignIn } from "./player-account-guard";
import {
  decideCrossClubLink,
  type CrossClubLinkFacts,
  type CrossClubLinkVerdict,
} from "./cross-club-link-rules";

export const CROSS_CLUB_LINK_REASON = "cross-club-phone-link";

export async function loadCrossClubLinkFacts(
  tx: TxClient,
  input: { orgId: string; dropUserId: string; phone: string },
): Promise<CrossClubLinkFacts> {
  const { orgId, dropUserId, phone } = input;

  const keepUser: { id: string; name: string | null; isSuperadmin: boolean } | null = await tx.user.findUnique({
    where: { phoneNumber: phone },
    select: { id: true, name: true, isSuperadmin: true },
  });

  let keep: CrossClubLinkFacts["keep"] = null;
  if (keepUser) {
    // Only the club's NAME is read from the other club, never a rating,
    // a role or any history.
    const mems: Array<{ orgId: string; leftAt: Date | null; guestFromOrgId: string | null; org: { name: string } }> =
      await tx.membership.findMany({
        where: { userId: keepUser.id },
        select: { orgId: true, leftAt: true, guestFromOrgId: true, org: { select: { name: true } } },
      });
    const rank = (m: { leftAt: Date | null; guestFromOrgId: string | null }) =>
      (m.leftAt ? 2 : 0) + (m.guestFromOrgId ? 1 : 0);
    const others = mems.filter((m) => m.orgId !== orgId).sort((a, b) => rank(a) - rank(b));
    keep = {
      id: keepUser.id,
      name: keepUser.name,
      isSuperadmin: keepUser.isSuperadmin === true,
      hasMembershipInOrg: mems.some((m) => m.orgId === orgId),
      clubNames: others.map((m) => m.org.name),
    };
  }

  const dropUser: {
    id: string;
    email: string | null;
    password: string | null;
    onboarded: boolean | null;
    emailVerified: Date | null;
    isSuperadmin: boolean | null;
  } | null = await tx.user.findUnique({
    where: { id: dropUserId },
    select: { id: true, email: true, password: true, onboarded: true, emailVerified: true, isSuperadmin: true },
  });
  const dropMem: { guestFromOrgId: string | null } | null = await tx.membership.findUnique({
    where: { userId_orgId: { userId: dropUserId, orgId } },
    select: { guestFromOrgId: true },
  });
  const otherClubMemberships: number = await tx.membership.count({
    where: { userId: dropUserId, orgId: { not: orgId } },
  });

  // Everything `mergePlayersCore` moves, counted where it is tied to a
  // club other than A. Any non-zero count refuses the link, so the merge
  // can only ever move club A's rows.
  const notA = { not: orgId };
  const inOtherMatch = { match: { activity: { orgId: notA } } };
  const counts: number[] = [
    await tx.attendance.count({ where: { userId: dropUserId, ...inOtherMatch } }),
    await tx.rating.count({ where: { raterId: dropUserId, ...inOtherMatch } }),
    await tx.rating.count({ where: { playerId: dropUserId, ...inOtherMatch } }),
    await tx.moMVote.count({ where: { voterId: dropUserId, ...inOtherMatch } }),
    await tx.moMVote.count({ where: { playerId: dropUserId, ...inOtherMatch } }),
    await tx.teamAssignment.count({ where: { userId: dropUserId, ...inOtherMatch } }),
    await tx.ratingAdjustment.count({ where: { userId: dropUserId, ...inOtherMatch } }),
    await tx.playerActivityPosition.count({ where: { userId: dropUserId, activity: { orgId: notA } } }),
    await tx.analyzedMessage.count({ where: { authorUserId: dropUserId, orgId: notA } }),
    await tx.userAlias.count({ where: { userId: dropUserId, orgId: notA } }),
    await tx.rosterSurveyDM.count({ where: { userId: dropUserId, survey: { orgId: notA } } }),
    await tx.rosterSurveyResponse.count({ where: { userId: dropUserId, survey: { orgId: notA } } }),
    await tx.squadMonthMember.count({ where: { userId: dropUserId, month: { orgId: notA } } }),
    await tx.squadCredit.count({ where: { userId: dropUserId, orgId: notA } }),
  ];
  const [accounts, sessions]: number[] = [
    await tx.account.count({ where: { userId: dropUserId } }),
    await tx.session.count({ where: { userId: dropUserId } }),
  ];

  return {
    orgId,
    drop: {
      id: dropUserId,
      membershipInOrg: dropUser && dropMem ? { guestFromOrgId: dropMem.guestFromOrgId } : null,
      otherClubMemberships,
      rowsOutsideOrg: counts.reduce((a, b) => a + b, 0),
      // #314's definition (player-account-guard.ts `hasOwnSignIn`): onboarded
      // (signed in by phone), an OAuth account, a password, a verified or
      // real email, or a superadmin. Plus any Session row.
      hasOwnSignIn:
        sessions > 0 ||
        (!!dropUser &&
          hasOwnSignIn({
            email: dropUser.email,
            onboarded: dropUser.onboarded === true,
            password: dropUser.password,
            emailVerified: dropUser.emailVerified ?? null,
            isSuperadmin: dropUser.isSuperadmin === true,
            accountCount: accounts,
            memberships: [],
          })),
    },
    keep,
  };
}

export type LinkAcrossClubsResult =
  | { ok: true; keptUserId: string }
  | { ok: false; verdict: Exclude<CrossClubLinkVerdict, { kind: "offer" }> };

/**
 * Link club A's player to the existing account that holds `phone`.
 * The caller has already checked the actor is an OWNER or ADMIN of A.
 */
export async function linkAcrossClubsCore(
  tx: TxClient,
  input: { orgId: string; dropUserId: string; phone: string; actorUserId: string },
): Promise<LinkAcrossClubsResult> {
  const facts = await loadCrossClubLinkFacts(tx, input);
  const verdict = decideCrossClubLink(facts);
  if (verdict.kind !== "offer") return { ok: false, verdict };
  const keptUserId = facts.keep!.id;

  // Kept: the existing account (its id and phone stay). Dropped: club A's
  // row. Alias and tombstone scoped to club A only.
  // keepIdentity: the existing account's global name and image are never
  // filled from club A's row (the #314 rule).
  await mergePlayersCore(tx, keptUserId, input.dropUserId, { saveAliasInOrgIds: [input.orgId], keepIdentity: true });

  // The audit row: `mergePlayersCore` wrote one tombstone for club A
  // (who-was-merged-into-whom, when). Add who did it and why.
  await tx.userMerge.updateMany({
    where: { oldUserId: input.dropUserId, survivorUserId: keptUserId, orgId: input.orgId },
    data: { actorUserId: input.actorUserId, reason: CROSS_CLUB_LINK_REASON },
  });

  return { ok: true, keptUserId };
}
