/**
 * Link a person who has just joined a club's WhatsApp group (known by
 * phone) to the phoneless placeholder a third party's "X in" created for
 * them earlier. The rules are `placeholder-link-rules.ts`; this is the
 * reading and the merge.
 *
 * Called by group-join and the participant sweep AFTER the joiner's own
 * membership has been written, so `mergePlayersCore` folds the
 * placeholder's membership (its seed, Elo, provisional stamp) into the
 * joiner's, and moves its attendance, team place, ratings and aliases.
 *
 * The safety rules are checked twice: once on the read, and again inside
 * the transaction, because a placeholder could have gained a phone or a
 * second club between the two. A merge that fails for any reason never
 * fails the join: the caller gets a suggestion and the admin decides.
 */
import { db } from "./db";
import { mergePlayersCore } from "./merge-players-core";
import {
  decidePlaceholderLink,
  placeholderAddedAt,
  type PlaceholderCandidate,
} from "./placeholder-link-rules";

export type LinkOutcome =
  | { kind: "linked"; placeholderUserId: string; placeholderName: string; addedAt: Date }
  | { kind: "suggest"; candidates: Array<{ userId: string; name: string; addedAt: Date }> }
  | { kind: "none" };

function suggestion(cands: PlaceholderCandidate[]): LinkOutcome {
  return {
    kind: "suggest",
    candidates: cands.map((c) => ({ userId: c.userId, name: c.name ?? "", addedAt: placeholderAddedAt(c) })),
  };
}

export async function linkJoinerToPlaceholder(
  orgId: string,
  joinerUserId: string,
  opts: { extraNames?: Array<string | null | undefined> } = {},
): Promise<LinkOutcome> {
  let candidates: PlaceholderCandidate[];
  let joinerNames: string[];
  let joinerPhone: string | null;
  try {
    const joiner = await db.user.findUnique({
      where: { id: joinerUserId },
      select: { id: true, name: true, phoneNumber: true },
    });
    joinerPhone = joiner?.phoneNumber ?? null;
    if (!joiner || !joinerPhone) return { kind: "none" };

    const joinerAliases = await db.userAlias.findMany({
      where: { orgId, userId: joinerUserId },
      select: { alias: true },
    });
    joinerNames = [joiner.name, ...(opts.extraNames ?? []), ...joinerAliases.map((a) => a.alias)].filter(
      (n): n is string => !!n,
    );
    if (joinerNames.length === 0) return { kind: "none" };

    // Phoneless, current members of THIS club only. `_count.memberships`
    // counts every club, which is how a placeholder that also belongs to
    // another club is refused by the rules.
    const rows = await db.membership.findMany({
      where: { orgId, leftAt: null, userId: { not: joinerUserId }, user: { phoneNumber: null } },
      select: {
        userId: true,
        leftAt: true,
        provisionallyAddedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phoneNumber: true,
            createdAt: true,
            _count: { select: { memberships: true } },
          },
        },
      },
    });
    if (rows.length === 0) return { kind: "none" };
    const aliasRows = await db.userAlias.findMany({
      where: { orgId, userId: { in: rows.map((r) => r.userId) } },
      select: { userId: true, alias: true },
    });
    candidates = rows.map((r) => ({
      userId: r.user.id,
      name: r.user.name,
      phoneNumber: r.user.phoneNumber,
      email: r.user.email,
      provisionallyAddedAt: r.provisionallyAddedAt,
      leftAt: r.leftAt,
      createdAt: r.user.createdAt,
      clubCount: r.user._count.memberships,
      aliases: aliasRows.filter((a) => a.userId === r.userId).map((a) => a.alias),
    }));
  } catch (err) {
    console.error(`[placeholder-link] read failed for ${joinerUserId} in ${orgId}:`, err);
    return { kind: "none" };
  }

  const decision = decidePlaceholderLink(
    { userId: joinerUserId, phoneNumber: joinerPhone, names: joinerNames },
    candidates,
  );
  if (decision.kind === "none") return decision;
  if (decision.kind === "suggest") return suggestion(decision.candidates);

  const ph = decision.placeholder;
  try {
    const merged = await db.$transaction(
      async (tx) => {
        // Re-check inside the transaction: still phoneless, still this
        // club only, and the joiner still holds a phone.
        const [dropUser, keepUser, dropClubs] = await Promise.all([
          tx.user.findUnique({ where: { id: ph.userId }, select: { phoneNumber: true } }),
          tx.user.findUnique({ where: { id: joinerUserId }, select: { phoneNumber: true } }),
          tx.membership.findMany({ where: { userId: ph.userId }, select: { orgId: true } }),
        ]);
        if (!dropUser || dropUser.phoneNumber) return false;
        if (!keepUser?.phoneNumber) return false;
        if (dropClubs.length !== 1 || dropClubs[0].orgId !== orgId) return false;
        await mergePlayersCore(tx, joinerUserId, ph.userId, { saveAliasInOrgIds: [orgId] });
        return true;
      },
      { timeout: 60_000 },
    );
    if (!merged) return suggestion([ph]);
    console.log(`[placeholder-link] merged placeholder ${ph.userId} (${ph.name}) into ${joinerUserId} in ${orgId}`);
    return {
      kind: "linked",
      placeholderUserId: ph.userId,
      placeholderName: ph.name ?? "",
      addedAt: placeholderAddedAt(ph),
    };
  } catch (err) {
    console.error(`[placeholder-link] merge of ${ph.userId} into ${joinerUserId} failed:`, err);
    return suggestion([ph]);
  }
}
