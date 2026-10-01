/**
 * The badge share card (Kemal, 2026-10-01): a PNG of ONE badge a player
 * has earned, public by cuid like the Wrapped card, so it can go
 * straight into a WhatsApp chat.
 *
 * The guard is the whole feature's safety: the image renders only for a
 * badge the player has actually EARNED, at a club they are a current
 * member of. Anything else is a 404, never a greyed-out card, because a
 * public URL that renders "not earned" would let anyone probe a
 * player's progress.
 *
 * And the card may only carry what the group can already see: a badge's
 * name and meaning, the player's name and the club's name. No rating,
 * and never a seed. `loadEarnedBadgeCard` returns exactly those fields,
 * so the route cannot render anything else even by accident.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Badge, PlayerSeasonStats } from "@/lib/player-stats";

let membership: { leftAt: Date | null } | null = null;
let stats: Partial<PlayerSeasonStats> | null = null;
const membershipCalls: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findUnique: (args: unknown) => {
        membershipCalls.push(args);
        return Promise.resolve(membership);
      },
    },
  },
}));

vi.mock("@/lib/player-stats", () => ({
  loadPlayerSeasonStats: () => Promise.resolve(stats),
}));

import { findEarnedBadge, loadEarnedBadgeCard } from "../badge-card";

const BADGES: Badge[] = [
  { key: "first-game", emoji: "👟", label: "On the board", hint: "Played your first game", earned: true },
  { key: "ten-games", emoji: "🔟", label: "Regular", hint: "Played 10+ games", earned: false },
  { key: "mom-machine", emoji: "👑", label: "MoM Machine", hint: "Won MoM 3+ times", earned: true },
];

describe("findEarnedBadge", () => {
  it("returns the badge when the player has earned it", () => {
    expect(findEarnedBadge(BADGES, "mom-machine")?.label).toBe("MoM Machine");
  });

  it("returns null for a badge the player has not earned", () => {
    expect(findEarnedBadge(BADGES, "ten-games")).toBeNull();
  });

  it("returns null for a key that is not a badge at all", () => {
    expect(findEarnedBadge(BADGES, "made-up")).toBeNull();
    expect(findEarnedBadge(BADGES, "")).toBeNull();
  });
});

describe("loadEarnedBadgeCard", () => {
  beforeEach(() => {
    membership = { leftAt: null };
    membershipCalls.length = 0;
    stats = {
      orgId: "org-1",
      orgName: "Sutton FC",
      player: { id: "u-1", name: "Riley Rater", image: null },
      avgRating: 7.5,
      momCount: 3,
      badges: BADGES,
    };
  });

  it("returns the card for an earned badge at a club the player is in", async () => {
    const card = await loadEarnedBadgeCard("org-1", "u-1", "mom-machine");
    expect(card).toEqual({
      playerName: "Riley Rater",
      orgName: "Sutton FC",
      badge: { key: "mom-machine", emoji: "👑", label: "MoM Machine", hint: "Won MoM 3+ times" },
    });
    expect(membershipCalls[0]).toMatchObject({
      where: { userId_orgId: { userId: "u-1", orgId: "org-1" } },
    });
  });

  it("carries no rating, seed or other stat: only the badge, the name and the club", async () => {
    const card = await loadEarnedBadgeCard("org-1", "u-1", "mom-machine");
    expect(Object.keys(card!).sort()).toEqual(["badge", "orgName", "playerName"]);
    expect(Object.keys(card!.badge).sort()).toEqual(["emoji", "hint", "key", "label"]);
    expect(JSON.stringify(card)).not.toContain("7.5");
  });

  it("is null for a badge the player has not earned", async () => {
    expect(await loadEarnedBadgeCard("org-1", "u-1", "ten-games")).toBeNull();
  });

  it("is null for an unknown badge key", async () => {
    expect(await loadEarnedBadgeCard("org-1", "u-1", "nope")).toBeNull();
  });

  it("is null when the player is not a member of that club", async () => {
    membership = null;
    expect(await loadEarnedBadgeCard("org-1", "u-1", "mom-machine")).toBeNull();
  });

  it("is null when the player has left that club", async () => {
    membership = { leftAt: new Date("2026-09-01") };
    expect(await loadEarnedBadgeCard("org-1", "u-1", "mom-machine")).toBeNull();
  });

  it("is null when there are no stats for the player", async () => {
    stats = null;
    expect(await loadEarnedBadgeCard("org-1", "u-1", "mom-machine")).toBeNull();
  });

  it("falls back to 'Player' when the player has no name", async () => {
    stats = { ...stats!, player: { id: "u-1", name: null, image: null } };
    expect((await loadEarnedBadgeCard("org-1", "u-1", "mom-machine"))?.playerName).toBe("Player");
  });
});

describe("the badge card route", () => {
  const ROUTE = path.resolve(__dirname, "../../app/api/badge-card/[playerId]/[badgeKey]/route.tsx");

  it("reads only the guarded loader, never the season stats or a rating", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toContain("loadEarnedBadgeCard");
    expect(src).not.toContain("loadPlayerSeasonStats");
    expect(src).not.toMatch(/seedRating|avgRating|loadClubRating|loadAllClubsOverview/);
  });
});
