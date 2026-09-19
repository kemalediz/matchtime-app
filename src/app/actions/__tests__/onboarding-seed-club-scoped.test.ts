/**
 * A NEW CLUB'S SEEDS LAND ON THAT CLUB'S MEMBERSHIPS.
 *
 * Slice 4 of MDs/club-scoped-ratings-design-2026-09-18.md, and the half
 * of it that carries an explicit decision from Kemal (section 13,
 * question 5, answered 2026-09-18): a new club's admin IS offered the
 * seed editor during setup, exactly as Sutton FC was. That answer is
 * only safe if the seeds they type land on the membership of the org
 * being set up. On `User.seedRating` they would be a global opinion, so
 * seeding the Turkish club's roster in week one would quietly move nine
 * Sutton players' balancer inputs, which is the precise failure the
 * whole design exists to end.
 *
 * Two entry points write a seed during setup and both are covered here:
 *
 *   - `createOrgFromWizard` (/onboarding), where the admin types seeds
 *     straight into the wizard, including seeds for players who ALREADY
 *     exist because they play at another club.
 *   - `applyEnrichment` (/finish-setup/<id>), where the bot's analyser
 *     proposed them from the group's chat history.
 *
 * db / auth / org / next-cache are mocked. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const setCurrentOrgId = vi.fn();
const updatePlayerPhone = vi.fn();

// ── the wizard's transaction stub ──
const txUserCreate = vi.fn();
const txUserUpdateMany = vi.fn();
const txMembershipUpsert = vi.fn();
const txMembershipUpdate = vi.fn();

const orgFindUnique = vi.fn();
const userFindMany = vi.fn();
const transaction = vi.fn();

// ── finish-setup's direct writes ──
const onboardingSessionFindUnique = vi.fn();
const onboardingSessionUpdate = vi.fn();
const activityFindFirst = vi.fn();
const userUpdate = vi.fn();
const membershipUpdateMany = vi.fn();
const positionUpsert = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
  setCurrentOrgId: (...a: unknown[]) => setCurrentOrgId(...a),
}));
vi.mock("@/app/actions/players", () => ({
  updatePlayerPhone: (...a: unknown[]) => updatePlayerPhone(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    user: {
      findMany: (...a: unknown[]) => userFindMany(...a),
      update: (...a: unknown[]) => userUpdate(...a),
    },
    membership: { updateMany: (...a: unknown[]) => membershipUpdateMany(...a) },
    onboardingSession: {
      findUnique: (...a: unknown[]) => onboardingSessionFindUnique(...a),
      update: (...a: unknown[]) => onboardingSessionUpdate(...a),
    },
    activity: { findFirst: (...a: unknown[]) => activityFindFirst(...a) },
    playerActivityPosition: { upsert: (...a: unknown[]) => positionUpsert(...a) },
    match: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { createOrgFromWizard } from "@/app/actions/onboarding";
import { applyEnrichment } from "@/app/actions/finish-setup";

const ADMIN = "admin-1";
const NEW_ORG = "org-turkish-club";
/** Already plays at another club, so already has a User row. */
const EXISTING_USER = "user-plays-elsewhere";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: ADMIN } });
  requireOrgAdmin.mockResolvedValue(undefined);
  orgFindUnique.mockResolvedValue(null);
  userFindMany.mockResolvedValue([
    { id: EXISTING_USER, name: "Erdal", phoneNumber: "+905321112233" },
  ]);
  txUserCreate.mockImplementation(() => Promise.resolve({ id: `user-${txUserCreate.mock.calls.length}`, name: "x" }));
  txUserUpdateMany.mockResolvedValue({ count: 1 });
  txMembershipUpsert.mockResolvedValue({});
  txMembershipUpdate.mockResolvedValue({});
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      organisation: {
        create: vi.fn().mockResolvedValue({ id: NEW_ORG, slug: "turkish-club" }),
        update: vi.fn(),
      },
      sport: { create: vi.fn().mockResolvedValue({ id: "sport-1" }) },
      activity: { create: vi.fn().mockResolvedValue({ id: "act-1" }) },
      user: {
        create: (...a: unknown[]) => txUserCreate(...a),
        updateMany: (...a: unknown[]) => txUserUpdateMany(...a),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      membership: {
        upsert: (...a: unknown[]) => txMembershipUpsert(...a),
        update: (...a: unknown[]) => txMembershipUpdate(...a),
        findMany: vi.fn().mockResolvedValue([]),
      },
    }),
  );
});

const ACTIVITY = {
  sportKey: "football-7aside",
  name: "Friday 7s",
  dayOfWeek: 5,
  time: "18:00",
  venue: "Pitch",
  matchDurationMins: 60,
};

describe("createOrgFromWizard seeds the new club's memberships", () => {
  it("puts a brand new player's seed on their membership at the org being set up", async () => {
    await createOrgFromWizard({
      orgName: "Turkish Club",
      players: [{ name: "Yeni", seedRating: 8 }],
      activity: ACTIVITY,
    });

    const upserts = txMembershipUpsert.mock.calls.map((c) => c[0] as {
      where: { userId_orgId: { orgId: string } };
      create: Record<string, unknown>;
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].where.userId_orgId.orgId).toBe(NEW_ORG);
    expect(upserts[0].create).toMatchObject({ orgId: NEW_ORG, seedRating: 8 });
  });

  it("never writes seedRating onto a User row, new or existing", async () => {
    await createOrgFromWizard({
      orgName: "Turkish Club",
      players: [
        { name: "Yeni", seedRating: 8 },
        { name: "Erdal", phone: "+905321112233", seedRating: 9 },
      ],
      activity: ACTIVITY,
    });

    for (const call of txUserCreate.mock.calls) {
      expect((call[0] as { data: Record<string, unknown> }).data).not.toHaveProperty("seedRating");
    }
    // The old code nudged an EXISTING user's global seed when it was
    // blank. That user plays at another club; their seed there is not
    // this club's to set.
    expect(txUserUpdateMany).not.toHaveBeenCalled();
  });

  it("seeds an EXISTING player on the new club's membership only", async () => {
    await createOrgFromWizard({
      orgName: "Turkish Club",
      players: [{ name: "Erdal", phone: "+905321112233", seedRating: 9 }],
      activity: ACTIVITY,
    });

    const upserts = txMembershipUpsert.mock.calls.map((c) => c[0] as {
      where: { userId_orgId: { userId: string; orgId: string } };
      create: Record<string, unknown>;
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].where.userId_orgId).toEqual({ userId: EXISTING_USER, orgId: NEW_ORG });
    expect(upserts[0].create).toMatchObject({ seedRating: 9 });
  });

  it("seeds the admin themselves on their OWNER membership when they are in the list", async () => {
    userFindMany.mockResolvedValue([{ id: ADMIN, name: "Kemal", phoneNumber: "+447700900999" }]);

    await createOrgFromWizard({
      orgName: "Turkish Club",
      players: [{ name: "Kemal", phone: "+447700900999", seedRating: 7 }],
      activity: ACTIVITY,
    });

    // The owner membership already exists (created with the org), so the
    // wizard must not upsert a second PLAYER row for them, and must not
    // drop their seed on the floor either.
    expect(txMembershipUpsert).not.toHaveBeenCalled();
    const updates = txMembershipUpdate.mock.calls.map((c) => c[0] as {
      where: { userId_orgId: { userId: string; orgId: string } };
      data: Record<string, unknown>;
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].where.userId_orgId).toEqual({ userId: ADMIN, orgId: NEW_ORG });
    expect(updates[0].data).toEqual({ seedRating: 7 });
  });

  it("leaves a player the admin did not seed with no seed at all", async () => {
    await createOrgFromWizard({
      orgName: "Turkish Club",
      players: [{ name: "Unseeded" }],
      activity: ACTIVITY,
    });

    const create = (txMembershipUpsert.mock.calls[0][0] as { create: Record<string, unknown> }).create;
    expect(create.seedRating ?? null).toBeNull();
  });
});

describe("applyEnrichment seeds the session's club", () => {
  const SESSION = "onb-1";
  const ORG = "org-being-set-up";

  beforeEach(() => {
    onboardingSessionFindUnique.mockResolvedValue({
      id: SESSION,
      orgId: ORG,
      enrichmentStatus: "proposed",
    });
    onboardingSessionUpdate.mockResolvedValue({});
    activityFindFirst.mockResolvedValue(null);
    membershipUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("writes the analyser's proposed seed onto the membership at this org", async () => {
    const res = await applyEnrichment({
      sessionId: SESSION,
      players: [{ userId: EXISTING_USER, name: "Erdal", position: null, seedRating: 8 }],
      phones: [],
      schedule: { dayOfWeek: null, time: null, venue: null, playersPerSide: null },
    });

    expect(res.applied.seeds).toBe(1);
    expect(userUpdate).not.toHaveBeenCalled();
    const call = membershipUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ userId: EXISTING_USER, orgId: ORG });
    expect(call.data).toEqual({ seedRating: 8 });
  });

  it("does not count a seed for somebody with no membership at this club", async () => {
    membershipUpdateMany.mockResolvedValue({ count: 0 });

    const res = await applyEnrichment({
      sessionId: SESSION,
      players: [{ userId: "stranger", name: "Stranger", position: null, seedRating: 8 }],
      phones: [],
      schedule: { dayOfWeek: null, time: null, venue: null, playersPerSide: null },
    });

    expect(res.applied.seeds).toBe(0);
  });
});
