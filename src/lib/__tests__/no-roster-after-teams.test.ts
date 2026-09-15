/**
 * ONCE THE TEAMS ARE GENERATED, NOBODY POSTS THE SQUAD ROSTER.
 *
 * Sutton FC, 15 September 2026. Teams were generated at 16:41 and
 * announced. At 19:14 Wasim went out and at 19:15 Amir put Shahrokh in,
 * and MatchTime answered with the FOURTEEN-NAME SQUAD ROSTER TWICE in a
 * row: once as a reply (the `[SQUAD]` marker expanded by
 * `composeSquadStateReply`) and once as a group post
 * (`announceSquadFullIfJustFilled`, re-armed when the drop cleared its
 * dedupe key and fired again when the count returned to 14).
 *
 * The owner: "I agree there shouldn't be two messages, one after
 * another, saying the same information about the squad. And I don't
 * think we should even mention the squad because if the teams are
 * generated, all match time need to do is to declare the teams again
 * with the swapped replacement and the person that is out."
 *
 * Two paths, two halves of this file. The engine's own composition is
 * pinned in `pipeline/__tests__/compose.test.ts`; these are the two that
 * do not go through it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SQUAD_POST_MARKER,
  composeSquadStatusPost,
  composeSquadStateReply,
  type SquadTruth,
} from "@/lib/group-copy";

const CONFIRMED = [
  "Kemal Ediz", "Mustafa Kaya", "Idris Bello", "Najib Ahmadi",
  "Efat Rahman", "Mojib Sadat", "Karahan Yildiz", "Elvin Aliyev",
  "Adam Osman", "Erdal Ozkan", "Sait Demir", "Habib Rahman",
  "Faris Nasser", "Shahrokh",
];

const TEAMS: NonNullable<SquadTruth["teams"]> = {
  red: CONFIRMED.slice(0, 7),
  yellow: CONFIRMED.slice(7),
  labels: ["Red", "Yellow"],
  kickoff: "Tue 21:30",
  venue: "Goals North Cheam",
};

const base: SquadTruth = {
  confirmed: CONFIRMED,
  bench: [],
  maxPlayers: 14,
  knownNames: [...CONFIRMED, "Wasim Akhtar"],
};

describe("composeSquadStateReply — with a team sheet, the composed post IS the teams", () => {
  it("the `[SQUAD]` marker expands to the line-ups, never to fourteen names", () => {
    const out = composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: TEAMS });
    expect(out.composed).toBe(true);
    expect(out.text).toContain("⚽ *Teams for tonight* — Tue 21:30 at Goals North Cheam");
    expect(out.text).toContain("*Red*:");
    expect(out.text).toContain("*Yellow*:");
    expect(out.text).not.toContain("*Playing:*");
    expect(out.text).not.toContain("Based on all the messages");
  });

  it("a model reply that displays the squad is replaced by the teams", () => {
    const out = composeSquadStateReply(
      "Here's the squad:\n1. Kemal\n2. Elvin\n3. Sait",
      { ...base, teams: TEAMS },
    );
    expect(out.composed).toBe(true);
    expect(out.text).toContain("⚽ *Teams for tonight*");
    expect(out.text).not.toContain("*Playing:*");
  });

  it("a lead that makes no squad claim still survives in front of the teams", () => {
    const out = composeSquadStateReply(
      `Sorry to hear that Wasim 🤒\n\n${SQUAD_POST_MARKER}`,
      { ...base, teams: TEAMS },
    );
    expect(out.text.startsWith("Sorry to hear that Wasim 🤒")).toBe(true);
    expect(out.text).toContain("⚽ *Teams for tonight*");
  });

  it("WITHOUT a sheet it is byte-for-byte what it is today", () => {
    // THE REGRESSION THAT MATTERS. `teams: null` and `teams` absent must
    // both behave exactly as the shipped path does.
    const expected = composeSquadStatusPost({
      confirmed: base.confirmed,
      bench: base.bench,
      maxPlayers: base.maxPlayers,
    });
    expect(composeSquadStateReply(SQUAD_POST_MARKER, base).text).toBe(expected);
    expect(composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: null }).text).toBe(
      expected,
    );
  });

  it("an empty sheet is no sheet — `formatTeamsPost` over two empty lists is a lie", () => {
    // The 2026-09-06 sweep already caught this shape once: two empty
    // arrays render a team sheet with no players under either heading.
    const expected = composeSquadStatusPost({
      confirmed: base.confirmed,
      bench: base.bench,
      maxPlayers: base.maxPlayers,
    });
    expect(
      composeSquadStateReply(SQUAD_POST_MARKER, {
        ...base,
        teams: { ...TEAMS, red: [], yellow: [] },
      }).text,
    ).toBe(expected);
  });

  it("an ordinary reply is still not this function's business", () => {
    const out = composeSquadStateReply("Nice one 👍", { ...base, teams: TEAMS });
    expect(out.composed).toBe(false);
    expect(out.text).toBe("Nice one 👍");
  });
});

// ── The second roster post of the night ───────────────────────────────

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method),
          },
        ),
    },
  ),
}));

function matchRow(teamAssignments: number) {
  return {
    id: "m1",
    maxPlayers: 14,
    date: new Date("2026-09-15T20:30:00.000Z"),
    activity: { name: "Tuesday 7-a-side", orgId: "org1" },
    attendances: CONFIRMED.map((name, i) => ({
      status: "CONFIRMED",
      position: i + 1,
      user: { name },
    })),
    teamAssignments: Array.from({ length: teamAssignments }, (_, i) => ({
      id: `t${i}`,
      team: i < 7 ? "RED" : "YELLOW",
      userId: `u${i}`,
    })),
  };
}

describe("announceSquadFullIfJustFilled — silent once a sheet exists", () => {
  const created: unknown[] = [];

  beforeEach(() => {
    for (const k of Object.keys(overrides)) delete overrides[k];
    created.length = 0;
    overrides.sentNotification = { create: async (a: unknown) => a };
    overrides.botJob = {
      create: async (a: unknown) => {
        created.push(a);
        return a;
      },
    };
  });

  it("THE SECOND POST OF THE NIGHT: with teams generated it queues nothing", async () => {
    overrides.match = { findUnique: async () => matchRow(14) };
    const { announceSquadFullIfJustFilled } = await import("@/lib/squad-announce");
    await announceSquadFullIfJustFilled("m1");
    expect(created).toHaveLength(0);
  });

  it("with NO teams it announces exactly as it does today", async () => {
    overrides.match = { findUnique: async () => matchRow(0) };
    const { announceSquadFullIfJustFilled } = await import("@/lib/squad-announce");
    await announceSquadFullIfJustFilled("m1");
    expect(created).toHaveLength(1);
    const text = (created[0] as { data: { text: string } }).data.text;
    expect(text).toContain("✅ *Squad complete — 14/14*");
    expect(text).toContain("*Playing:*");
    expect(text).toContain("1. Kemal Ediz");
  });

  it("does not burn the dedupe key when it declines, so a later fill still announces", async () => {
    // If the sheet were deleted (a format switch wipes it) the squad
    // would fill again with nothing to say. The claim is made AFTER the
    // decision, not before it.
    const claims: unknown[] = [];
    overrides.sentNotification = {
      create: async (a: unknown) => {
        claims.push(a);
        return a;
      },
    };
    overrides.match = { findUnique: async () => matchRow(14) };
    const { announceSquadFullIfJustFilled } = await import("@/lib/squad-announce");
    await announceSquadFullIfJustFilled("m1");
    expect(claims).toHaveLength(0);
  });
});
