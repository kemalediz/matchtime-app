/**
 * "@Match Time keep Dan and Craig apart" IN THE PLAYERS' GROUP, on teams
 * that already exist (2026-11-16, the Vets). The teams extractor reads
 * `swap` with `apart` (or `pairings`); this decides, from the facts and the
 * team sheet, the fewest swaps that meet them and what to say. Pure:
 * `decideKeepChange` in `team-constraints.ts`; `team-swap-apply.ts` writes
 * what it decides.
 */
import { describe, expect, it } from "vitest";
import { decideKeepChange } from "../team-constraints";
import { playersSwapShape } from "../team-swap-apply";
import type { SwapCandidate } from "../team-slot-swap";
import type { PersonPicks } from "../pipeline/who-is-who";
import { refKey } from "../person-ref-key";

const P = (userId: string, team: "RED" | "YELLOW" | null, status: SwapCandidate["status"] = "CONFIRMED"): SwapCandidate => ({
  userId,
  name: userId.replace(/^u-/, "").replace(/^./, (c) => c.toUpperCase()),
  status,
  team,
});

// Red: Dan, Craig, Eli, Abe. Yellow: Finn, Gus, Hal, Bob. Ivo is on the bench.
const ROSTER: SwapCandidate[] = [
  P("u-dan", "RED"),
  P("u-craig", "RED"),
  P("u-eli", "RED"),
  P("u-abe", "RED"),
  P("u-finn", "YELLOW"),
  P("u-gus", "YELLOW"),
  P("u-hal", "YELLOW"),
  P("u-bob", "YELLOW"),
  P("u-ivo", null, "BENCH"),
];
const RATING: Record<string, number> = { "u-dan": 9, "u-craig": 8, "u-eli": 5, "u-abe": 3, "u-finn": 8.4, "u-gus": 6, "u-hal": 5.5, "u-bob": 5 };
const rating = (id: string) => RATING[id] ?? 6;

/** who-is-who's picks, as the model would make them: each name its member. */
const people = (...names: string[]): PersonPicks =>
  new Map(names.map((n) => [refKey(n), { kind: "member" as const, userId: `u-${n.toLowerCase()}` }])) as unknown as PersonPicks;

const decide = (over: Partial<Parameters<typeof decideKeepChange>[0]>) =>
  decideKeepChange({ together: [], apart: [], roster: ROSTER, sender: null, people: people("Dan", "Craig", "Finn", "Abe", "Bob"), rating, lang: "en", ...over });

describe("playersSwapShape: who plays with whom is a supported change", () => {
  const facts = (over: Record<string, unknown> = {}) => ({ swaps: [], moves: [], pairings: [], apart: [], swapSides: false, ...over });
  it("apart alone, together alone, or both: one change", () => {
    expect(playersSwapShape(facts({ apart: [["Dan", "Craig"]] }))).toEqual({ kind: "keep", together: [], apart: [["Dan", "Craig"]] });
    expect(playersSwapShape(facts({ pairings: [["Ali", "Habib"]] }))).toEqual({ kind: "keep", together: [["Ali", "Habib"]], apart: [] });
    expect(playersSwapShape(facts({ pairings: [["A", "B"]], apart: [["C", "D"]] }))).toEqual({ kind: "keep", together: [["A", "B"]], apart: [["C", "D"]] });
  });
  it("mixed with a named side or a move it stays unsupported (one line, nothing written)", () => {
    expect(playersSwapShape(facts({ apart: [["Dan", "Craig"]], moves: ["A", "B"] })).kind).toBe("unsupported");
    expect(playersSwapShape(facts({ apart: [["Dan", "Craig"]], swaps: [{ personRef: "Dan", team: "RED" }] })).kind).toBe("unsupported");
  });
});

describe("decideKeepChange", () => {
  it("keep Dan and Craig apart: one swap, the confirmation, and the sheet follows", () => {
    const d = decide({ apart: [["Dan", "Craig"]] });
    expect(d.kind).toBe("change");
    if (d.kind !== "change") return;
    // Craig (8) for Finn (8.4): the closest ratings one swap can give.
    expect(d.changes).toEqual(new Map([["u-craig", "YELLOW"], ["u-finn", "RED"]]));
    expect(d.lead).toBe("🔁 Swapped *Craig* and *Finn*, nobody dropped.\nDan and Craig are on different teams.\n\nUpdated teams:");
  });

  it("Turkish", () => {
    const d = decide({ apart: [["Dan", "Craig"]], lang: "tr" });
    if (d.kind !== "change") throw new Error(d.kind);
    expect(d.lead).toBe("🔁 *Craig* ile *Finn* yer değiştirdi, kimse çıkarılmadı.\nDan ve Craig farklı takımlarda.\n\nGüncel takımlar:");
  });

  it("already apart: nothing written, and it says so", () => {
    const d = decide({ apart: [["Dan", "Finn"]], people: people("Dan", "Finn") });
    expect(d).toEqual({ kind: "unchanged", allMet: true, reply: "Dan and Finn are on different teams.\nNothing needed changing.", logReason: expect.any(String) });
  });

  it("together on teams as they stand: one swap brings them onto one side", () => {
    const d = decide({ together: [["Abe", "Bob"]] });
    if (d.kind !== "change") throw new Error(d.kind);
    expect(d.lead).toContain("Abe and Bob are on the same team.");
  });

  it("a clash it cannot meet: says so, and writes nothing when no swap helps", () => {
    const d = decide({ together: [["Dan", "Craig"]], apart: [["Dan", "Craig"]] });
    expect(d.kind).toBe("unchanged");
    if (d.kind !== "unchanged") return;
    expect(d.allMet).toBe(false);
    expect(d.reply).toBe(
      "Dan and Craig are on the same team.\nI couldn't split Dan and Craig between the teams. It clashes with another request in the same message.",
    );
  });

  it("the same clash in Turkish", () => {
    const d = decide({ together: [["Dan", "Craig"]], apart: [["Dan", "Craig"]], lang: "tr" });
    if (d.kind !== "unchanged") throw new Error(d.kind);
    expect(d.reply).toBe("Dan ve Craig aynı takımda.\nDan ve Craig farklı takımlara konamadı. Aynı mesajdaki başka bir istekle çakışıyor.");
  });

  it("a name nobody can place: refused with the reason, never silently ignored", () => {
    const d = decide({ apart: [["Dan", "Zork"]] });
    expect(d.kind).toBe("refused");
    if (d.kind !== "refused") return;
    expect(d.reply).toBe(
      "I haven't changed the teams. I can't find a player called *Zork* for this match. Use the name they're registered under. Nothing changed and nobody was dropped.",
    );
  });

  it("somebody on the bench, not on the teams: the TRUE reason, never a clash (review of #619)", () => {
    const d = decide({ apart: [["Dan", "Ivo"]], people: people("Dan", "Ivo") });
    expect(d.kind).toBe("unchanged");
    if (d.kind !== "unchanged") return;
    expect(d.reply).toBe("I couldn't split Dan and Ivo between the teams. Ivo isn't on the teams.");
    const tr = decide({ apart: [["Dan", "Ivo"]], people: people("Dan", "Ivo"), lang: "tr" });
    if (tr.kind !== "unchanged") throw new Error(tr.kind);
    expect(tr.reply).toBe("Dan ve Ivo farklı takımlara konamadı. Ivo takımlarda değil.");
  });

  it("a slot holder who dropped out is not on the teams either", () => {
    const roster = ROSTER.map((r) => (r.userId === "u-craig" ? { ...r, status: "DROPPED" as const } : r));
    const d = decide({ apart: [["Dan", "Craig"]], roster });
    if (d.kind !== "unchanged") throw new Error(d.kind);
    expect(d.reply).toBe("I couldn't split Dan and Craig between the teams. Craig isn't on the teams.");
  });

  it("'me' with no place on the teams: the sender is named as not on the teams", () => {
    const d = decide({ apart: [["me", "Craig"]], sender: { userId: "u-ivo", name: "Ivo" } });
    if (d.kind !== "unchanged") throw new Error(d.kind);
    expect(d.reply).toBe("I couldn't split Ivo and Craig between the teams. Ivo isn't on the teams.");
  });

  it("'me' is the sender", () => {
    const d = decide({ apart: [["me", "Craig"]], sender: { userId: "u-dan", name: "Dan" } });
    if (d.kind !== "change") throw new Error(d.kind);
    expect(d.lead).toContain("Dan and Craig are on different teams.");
  });

  it("no teams yet: nothing stored, and it says to ask with the teams", () => {
    const d = decide({ apart: [["Dan", "Craig"]], roster: ROSTER.map((r) => ({ ...r, team: null })) });
    expect(d).toEqual({ kind: "not-made", reply: expect.stringContaining("The teams aren't made yet."), logReason: expect.any(String) });
  });
});
