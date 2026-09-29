/**
 * "@Match Time delete these teams, early to form them, there is still 5
 * days" (Sutton FC, Thu 24 Sep 22:52 BST). It reached `admin_ops`, came
 * back `other`, and NOTHING happened: the early sheet stood, the noon
 * cron published it, and match day was spent patching it.
 *
 * The clear is now a deterministic step on the raw text
 * (`isClearTeamsRequest`) and this apply layer, which is pure over
 * injected deps. Admins only; a non-admin is told so; never silent.
 */
import { describe, expect, it } from "vitest";
import { applyClearTeams, type TeamClearDeps } from "../team-clear";

const TUE = new Date("2026-09-29T19:30:00Z");

function deps(over: Partial<TeamClearDeps> = {}) {
  const cleared: string[] = [];
  const d: TeamClearDeps = {
    isAdmin: async (userId) => userId === "u-kemal",
    selectTeamsMatch: async () => ({ id: "match-tue", date: TUE }),
    clearTeams: async (matchId) => {
      cleared.push(matchId);
      return { deleted: 14, statusReset: true };
    },
    ...over,
  };
  return { d, cleared };
}

describe("clearing the teams", () => {
  it("an admin clears them: rows gone, match back to UPCOMING, one short line", async () => {
    const { d, cleared } = deps();
    const res = await applyClearTeams({ senderUserId: "u-kemal", lang: "en", deps: d });
    expect(cleared).toEqual(["match-tue"]);
    expect(res.kind).toBe("cleared");
    expect(res.matchId).toBe("match-tue");
    expect(res.reply).toBe("Teams cleared. I'll build new ones on match day when asked.");
    expect(res.reply!.split("\n")).toHaveLength(1);
  });

  it("in Turkish for a Turkish group", async () => {
    const { d } = deps();
    const res = await applyClearTeams({ senderUserId: "u-kemal", lang: "tr", deps: d });
    expect(res.reply).toBe("Takımlar silindi. Maç günü istenince yenilerini kurarım.");
  });

  it("a NON-ADMIN is refused politely and nothing is touched", async () => {
    const { d, cleared } = deps();
    const res = await applyClearTeams({ senderUserId: "u-riley", lang: "en", deps: d });
    expect(cleared).toEqual([]);
    expect(res.kind).toBe("not_admin");
    expect(res.reply).toBe("Only an admin can clear the teams.");
  });

  it("the refusal in Turkish", async () => {
    const { d } = deps();
    const res = await applyClearTeams({ senderUserId: "u-riley", lang: "tr", deps: d });
    expect(res.reply).toBe("Takımları sadece bir admin silebilir.");
  });

  it("an unresolved sender is not an admin", async () => {
    const { d, cleared } = deps();
    const res = await applyClearTeams({ senderUserId: null, lang: "en", deps: d });
    expect(cleared).toEqual([]);
    expect(res.kind).toBe("not_admin");
  });

  it("no teams to clear: says so rather than claiming a clear", async () => {
    const { d } = deps({ clearTeams: async () => ({ deleted: 0, statusReset: false }) });
    const res = await applyClearTeams({ senderUserId: "u-kemal", lang: "en", deps: d });
    expect(res.kind).toBe("nothing");
    expect(res.reply).toBe("There are no teams to clear.");
  });

  it("no match lined up: the same honest line", async () => {
    const { d, cleared } = deps({ selectTeamsMatch: async () => null });
    const res = await applyClearTeams({ senderUserId: "u-kemal", lang: "tr", deps: d });
    expect(cleared).toEqual([]);
    expect(res.kind).toBe("nothing");
    expect(res.reply).toBe("Silinecek takım yok.");
  });

  it("a write that throws claims nothing cheerful (§3.2 S7)", async () => {
    const { d } = deps({
      clearTeams: async () => {
        throw new Error("db down");
      },
    });
    const res = await applyClearTeams({ senderUserId: "u-kemal", lang: "en", deps: d });
    expect(res.kind).toBe("failed");
    expect(res.reply).toBeNull();
    expect(res.logReason).toMatch(/db down/);
  });
});
