/**
 * A PLAYER'S SEED CARRIED INTO A NEW CLUB (Kemal, 2026-11-03): "an
 * existing player from other clubs can have the same seed rating when
 * they join a new club. Their average rating can be put in as a seed
 * rating for that club".
 *
 * Pure, no Prisma. The reads are in `carried-seed-loader.ts`, and the
 * one place that calls both is the Prisma client itself (`db.ts`), so
 * every way a membership is created (WhatsApp import, self-join, friend
 * link, partner or pool guest, admin add, a new club's owner) gets the
 * same rule without any join path having to remember it.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────
 *
 *   seed = round( sum(rating_c x games_c) / sum(games_c) ), clamped to 1..10
 *
 * over every OTHER club c where the player has a shown club rating:
 *
 *   rating_c  his club rating at c as players and admins see it there
 *             (`clubDisplayRating`: the raw mean of the newest 60 ratings
 *             that club gave him). Not the balancer's shrunk figure: that
 *             is pulled toward c's own seed, so carrying it would carry
 *             c's admin's guess rather than what team-mates said.
 *   games_c   how many distinct games c rated him in. A 9 from one game
 *             at a club he guested for once must not outweigh a 7 over a
 *             season at his own club.
 *
 * Rounded to a whole number because that is the seed box's precision
 * (`seedBoxValue`, `step={1}`): what the admin sees in the box is
 * exactly what the balancer then uses.
 *
 * ── WHEN IT APPLIES ──────────────────────────────────────────────────
 *
 *   - only when a membership is CREATED with no seed. A seed somebody
 *     typed (onboarding's box) is kept, and an existing row is never
 *     touched: an admin's seed is never overwritten.
 *   - no rating at any other club: nothing is written, and the seed
 *     stays NULL, read as the default 6 (`default-seed.ts`).
 *   - guests too: a partner or pool guest gets the carried seed at the
 *     club he guests for, so the balancer places him sensibly.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────
 *
 * The new club gets one whole number in its seed box and nothing else:
 * not which clubs it came from, not their ratings, not that it was
 * carried at all. It is a plain seed the admin can change like any
 * other. Players never see seeds (`clubDisplayRating` ignores them).
 */

/** The seed box's range (`seedPlayerRating`, the admin page inputs). */
export const SEED_MIN = 1;
export const SEED_MAX = 10;

export interface OtherClubRating {
  orgId: string;
  /** `clubDisplayRating` at that club, null when it never rated him. */
  rating: number | null;
  /** Distinct games that club rated him in. */
  ratedGames: number;
}

export interface CarriedSeed {
  seed: number;
  /** The clubs the seed was averaged from. For logs and the backfill
   *  report only, never shown to the new club. */
  fromOrgIds: string[];
}

/** The seed a player carries from his other clubs, or null for none. */
export function carriedSeed(others: readonly OtherClubRating[]): CarriedSeed | null {
  const used = others.filter((c) => c.rating != null && c.ratedGames > 0);
  if (used.length === 0) return null;
  const games = used.reduce((s, c) => s + c.ratedGames, 0);
  const mean = used.reduce((s, c) => s + (c.rating as number) * c.ratedGames, 0) / games;
  const seed = Math.max(SEED_MIN, Math.min(SEED_MAX, Math.round(mean)));
  return { seed, fromOrgIds: used.map((c) => c.orgId) };
}

/** True when a membership being created has no seed of its own yet. */
export function needsCarriedSeed(seedRating: number | null | undefined): boolean {
  return seedRating == null;
}

/**
 * The membership-create payload with the carried seed filled in, when it
 * has none and there is one to carry. Never throws: a failed read leaves
 * the payload as it was, so a join can never fail because of this.
 *
 * `excludeOrgId` is the club being joined; its own ratings are not
 * "other clubs" (a returning player's row is an update, not a create,
 * but a club's ratings never seed that same club either way). Null for
 * a club being created, which has no ratings yet.
 */
export async function fillCarriedSeed<T extends object>(
  data: T,
  ids: { userId: string | undefined; orgId: string | null | undefined },
  read: (userId: string, excludeOrgId: string | null) => Promise<CarriedSeed | null>,
): Promise<T> {
  if (!data || !needsCarriedSeed((data as { seedRating?: number | null }).seedRating) || !ids.userId) return data;
  try {
    const carried = await read(ids.userId, ids.orgId ?? null);
    if (!carried) return data;
    return { ...data, seedRating: carried.seed };
  } catch (err) {
    console.error("[carried-seed] not read:", err instanceof Error ? err.message : "failed");
    return data;
  }
}

/**
 * The payload rewrites `db.ts` runs on every membership create. Kept
 * here, with no Prisma, so the shapes it handles are unit tested
 * without a client: the unchecked `{ userId, orgId }` form, the
 * `{ user: { connect } }` form, `createMany` rows, and a new club's
 * owner nested inside `organisation.create`.
 */
type MembershipCreateData = { userId?: string; orgId?: string; seedRating?: number | null; user?: { connect?: { id?: string } }; org?: { connect?: { id?: string } } };

export function carriedSeedHook(read: (userId: string, excludeOrgId: string | null) => Promise<CarriedSeed | null>) {
  const fill = <D>(data: D, orgId?: string | null): Promise<D> => {
    const d = data as unknown as MembershipCreateData;
    if (!d || typeof d !== "object") return Promise.resolve(data);
    return fillCarriedSeed(
      d,
      { userId: d.userId ?? d.user?.connect?.id, orgId: orgId !== undefined ? orgId : (d.orgId ?? d.org?.connect?.id) },
      read,
    ) as unknown as Promise<D>;
  };
  return {
    /** `membership.create` data. */
    create: <D>(data: D) => fill(data),
    /** `membership.createMany` data, one row or many. */
    createMany: async <D>(data: D): Promise<D> =>
      (Array.isArray(data) ? await Promise.all(data.map((row) => fill(row))) : await fill(data)) as D,
    /** `organisation.create`: the nested `memberships.create`, a club
     *  that does not exist yet, so every rated club is "another club". */
    organisationCreate: async <D>(data: D): Promise<D> => {
      const d = data as unknown as { memberships?: { create?: unknown } };
      const nested = d?.memberships?.create;
      if (!nested) return data;
      const filled = Array.isArray(nested)
        ? await Promise.all(nested.map((row) => fill(row, null)))
        : await fill(nested, null);
      return { ...d, memberships: { ...d.memberships, create: filled } } as unknown as D;
    },
  };
}


/** One membership the backfill would seed. */
export interface CarriedSeedPlan {
  membershipId: string;
  orgId: string;
  userId: string;
  seed: number;
  fromOrgIds: string[];
}

/**
 * The backfill's plan (`scripts/_tmp-backfill-carried-seeds.ts`): for
 * each membership with no seed, the seed its player carries from his
 * other clubs. Memberships that already have a seed, and players with no
 * rating at any other club, are left out.
 */
export function planCarriedSeeds(
  memberships: ReadonlyArray<{ id: string; orgId: string; userId: string; seedRating: number | null }>,
  ratingsByUser: ReadonlyMap<string, readonly OtherClubRating[]>,
): CarriedSeedPlan[] {
  const out: CarriedSeedPlan[] = [];
  for (const m of memberships) {
    if (!needsCarriedSeed(m.seedRating)) continue;
    const carried = carriedSeed((ratingsByUser.get(m.userId) ?? []).filter((c) => c.orgId !== m.orgId));
    if (carried) out.push({ membershipId: m.id, orgId: m.orgId, userId: m.userId, seed: carried.seed, fromOrgIds: carried.fromOrgIds });
  }
  return out;
}
