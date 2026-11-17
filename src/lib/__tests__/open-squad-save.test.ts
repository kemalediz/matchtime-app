/**
 * SWITCHING THE OPEN SQUAD ON OR OFF (2026-11-17): the one core the
 * settings page and the WhatsApp tag both use (`setOpenSquad`).
 *
 *   on   the club's flag is set; anyone left waiting on the bench of a game
 *        still to be played comes in (there is no bench any more), through
 *        the one attendance writer, and the reply names them. No format is
 *        asked for.
 *   off  the flag is cleared; the places fall back to the game's own
 *        format, and every player already in STAYS in (nobody is bumped).
 *   same nothing is written; the reply says it was already so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: { openSquad: false, language: "en" as string | null },
  benchRows: [] as Array<{ matchId: string; userId: string; user: { name: string | null } }>,
  updates: [] as Array<Record<string, unknown>>,
  promoted: [] as string[],
  confirmed: 15,
}));

vi.mock("../db", () => ({
  db: {
    organisation: {
      findUnique: async () => ({ ...h.org }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        h.updates.push(data);
        if (typeof data.openSquad === "boolean") h.org.openSquad = data.openSquad;
        return { ...h.org };
      },
    },
    attendance: {
      findMany: async () => h.benchRows,
      count: async () => h.confirmed,
    },
    activity: {
      findFirst: async () => ({ name: "Football 7-a-side", minPlayers: 12, sport: { playersPerTeam: 7 }, matches: [{ maxPlayers: 14 }] }),
    },
  },
}));
vi.mock("../attendance", () => ({
  registerAttendance: vi.fn(async (userId: string) => {
    h.promoted.push(userId);
    return { status: "CONFIRMED" };
  }),
}));

import { setOpenSquad } from "../open-squad-save";
import { registerAttendance } from "../attendance";

const NOW = new Date("2026-11-17T18:00:00Z");

beforeEach(() => {
  h.org = { openSquad: false, language: "en" };
  h.benchRows = [];
  h.updates = [];
  h.promoted = [];
  vi.mocked(registerAttendance).mockClear();
});

describe("setOpenSquad", () => {
  it("on: sets the flag, records it as the organiser's choice, and says what it means", async () => {
    const r = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(r.outcome).toBe("open-squad-on");
    expect(h.org.openSquad).toBe(true);
    expect(h.updates[0]).toMatchObject({ openSquad: true, settingsSetByOrganiser: { push: ["openSquad"] } });
    expect(r.replyText).toBe(
      "✅ Done: no squad limit and no bench from now on. Everyone who says *IN* plays, and the teams are split evenly between whoever is in. I'll only ask for players while you're below 12.",
    );
    expect(r.replyText).not.toMatch(/a-side/);
  });

  it("on: anyone waiting on the bench of a game to come comes in, through the attendance writer, and is named", async () => {
    h.benchRows = [
      { matchId: "m1", userId: "recai", user: { name: "Recai Demir" } },
      { matchId: "m1", userId: "ali", user: { name: "Ali Khan" } },
    ];
    const r = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(h.promoted).toEqual(["recai", "ali"]);
    expect(vi.mocked(registerAttendance).mock.calls[0][2]).toMatchObject({
      promoteFromBench: true,
      event: { cause: "bench-moved-up", actorKind: "admin", actorUserId: "owner", sourceRef: "open-squad:on" },
    });
    expect(r.replyText).toContain("Recai Demir and Ali Khan were on the bench and are in now.");
  });

  it("off: clears the flag, nobody is bumped, and the reply names the game's own places", async () => {
    h.org.openSquad = true;
    const r = await setOpenSquad({ orgId: "vets", on: false, actorUserId: "owner", now: NOW });
    expect(r.outcome).toBe("open-squad-off");
    expect(h.org.openSquad).toBe(false);
    expect(registerAttendance).not.toHaveBeenCalled();
    expect(r.replyText).toBe(
      "✅ Done: the squad has a limit again, *Football 7-a-side* with 14 places. Everyone already in stays in; anyone who says *IN* after it is full goes on the bench.",
    );
  });

  it("already as asked: nothing written", async () => {
    h.org.openSquad = true;
    const r = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(r.outcome).toBe("open-squad-unchanged");
    expect(h.updates).toHaveLength(0);
    expect(r.replyText).toBe("No change: there is already no squad limit. Everyone who says *IN* plays; the minimum is 12.");
  });

  it("Turkish", async () => {
    h.org = { openSquad: false, language: "tr" };
    const on = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(on.replyText).toBe(
      "✅ Tamam: artık kadro sınırı ve yedek yok. *VARIM* yazan herkes oynar, takımlar gelenler arasında eşit bölünür. Yalnızca 12 kişinin altındayken oyuncu ararım.",
    );
    const off = await setOpenSquad({ orgId: "vets", on: false, actorUserId: "owner", now: NOW });
    expect(off.replyText).toBe(
      "✅ Tamam: kadronun yine bir sınırı var, *Football 7-a-side* için 14 kişi. Listede olan herkes kalır; kadro dolduktan sonra *VARIM* yazan yedeğe girer.",
    );
  });
});
