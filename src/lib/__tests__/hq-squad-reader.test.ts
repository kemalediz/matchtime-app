/**
 * THE HQ SQUAD READER (2026-10-29): its user turn, its answer check and the
 * adapter around the model call, with a stubbed model. The model decides
 * what a multi-line HQ message is; these pin what code does with the
 * answer: refs it was not shown are no member, an "out" ref must be a
 * playing member and not on the list, a new name must be in the message,
 * and anything unreadable is "other", which changes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildHqSquadReaderUserTurn,
  HQ_SQUAD_READER_SCHEMA,
  HQ_SQUAD_READER_SYSTEM,
  parseHqSquadReading,
  type HqSquadReaderContext,
  type HqSquadReaderInput,
} from "../hq-squad-reader-prompt";
import { readHqSquadMessage } from "../hq-squad-reader";
import type { PipelineModel } from "../pipeline/llm";

const NOW = new Date("2026-10-29T18:04:47Z");
const NAMES = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo", "Uncle Najib", "Yorel", "Maj", "Imz", "Akram", "Shehryar", "Naim Khan"];
const ctx: HqSquadReaderContext = {
  orgId: "org-fnf",
  game: { label: "Fri 30 Oct, 20:30", places: 18 },
  members: NAMES.map((name, i) => ({ ref: `p${i + 1}`, userId: `u-${i + 1}`, name, aliases: name === "Imz" ? ["Imran"] : [] })),
  squad: { playing: ["u-1", "u-2", "u-3", "u-4", "u-5", "u-6", "u-7", "u-8", "u-9", "u-10", "u-11"], bench: [] },
  teams: { state: "proposed", sides: [{ label: "Non Bibs", userIds: ["u-1", "u-2", "u-3", "u-4", "u-5", "u-6"] }, { label: "Bibs", userIds: ["u-7", "u-8", "u-9", "u-10", "u-11"] }] },
};
const input = (body: string, extra: Partial<HqSquadReaderInput> = {}): HqSquadReaderInput => ({
  body,
  sender: { userId: "u-3", name: "Rafi" },
  history: [],
  reply: null,
  now: NOW,
  ...extra,
});

describe("the prompt", () => {
  it("says the three kinds and keeps to the house rules (no em or en dashes)", () => {
    expect(HQ_SQUAD_READER_SYSTEM).toMatch(/"squad"/);
    expect(HQ_SQUAD_READER_SYSTEM).toMatch(/"teams"/);
    expect(HQ_SQUAD_READER_SYSTEM).toMatch(/"other"/);
    expect(HQ_SQUAD_READER_SYSTEM).not.toMatch(/[–—]/);
    expect(HQ_SQUAD_READER_SCHEMA.required).toEqual(["kind", "lines", "out"]);
  });

  it("the user turn shows the game, members by ref, the squad, the teams, the recent HQ messages and the message", () => {
    const turn = buildHqSquadReaderUserTurn(
      input("Mo\nMojib", { history: [{ author: "MatchTime", body: "📝 Proposed teams" }, { author: "AH", body: "Swap them over" }] }),
      ctx,
    );
    expect(turn).toContain("THE NEXT GAME: Fri 30 Oct, 20:30, 18 places");
    expect(turn).toContain("p9: Imz (also: Imran)");
    expect(turn).toMatch(/THE SQUAD AS MATCHTIME HAS IT[^\n]*\n\s+Playing \(11\): p1 Feroz, p2 Alamgir/);
    expect(turn).toContain("Non Bibs: p1 Feroz, p2 Alamgir, p3 Rafi");
    expect(turn).toContain("still waiting for YES");
    expect(turn).toContain("MatchTime: 📝 Proposed teams");
    expect(turn).toContain("AH: Swap them over");
    expect(turn.trim().endsWith("Mo\nMojib")).toBe(true);
    expect(turn).toContain("From Rafi (p3).");
  });
});

describe("the answer, checked", () => {
  it("teams and other change nothing", () => {
    expect(parseHqSquadReading({ kind: "teams", lines: [], out: [] }, input("x\ny"), ctx)).toEqual({ kind: "teams" });
    expect(parseHqSquadReading({ kind: "other", lines: [], out: [] }, input("x\ny"), ctx)).toMatchObject({ kind: "other" });
    expect(parseHqSquadReading(null, input("x\ny"), ctx)).toMatchObject({ kind: "other" });
    expect(parseHqSquadReading({ kind: "nonsense" }, input("x\ny"), ctx)).toMatchObject({ kind: "other" });
  });

  it("a squad: members by ref, a new person's name kept only when it is in the message, non-names dropped", () => {
    const r = parseHqSquadReading(
      {
        kind: "squad",
        lines: [
          { name: "Feroz", member: "p1", section: "playing", person: true },
          { name: "Imran", member: "p9", section: "playing", person: true },
          { name: "Bilal", member: "", section: "playing", person: true },
          { name: "Swap", member: "", section: "playing", person: false },
          { name: "Ghost", member: "", section: "playing", person: true },
          { name: "Who", member: "p99", section: "bench", person: true },
          { name: "Akram", member: "p10", section: "bench", person: true },
        ],
        out: ["p11", "p1", "p12", "p99"],
      },
      input("Swap\n1. Feroz\n2. Imran\n3. bilal\nBench\nAkram"),
      ctx,
    );
    expect(r).toEqual({
      kind: "squad",
      lines: [
        { name: "Feroz", userId: "u-1", section: "playing" },
        { name: "Imran", userId: "u-9", section: "playing" },
        { name: "Bilal", userId: null, section: "playing" },
        { name: "Akram", userId: "u-10", section: "bench" },
      ],
      // p11 is playing and not listed; p1 is listed; p12 is not playing; p99 unknown.
      out: ["u-11"],
    });
  });

  it("a squad with no lines is other", () => {
    expect(parseHqSquadReading({ kind: "squad", lines: [], out: [] }, input("a\nb"), ctx)).toMatchObject({ kind: "other" });
  });
});

describe("readHqSquadMessage (the adapter)", () => {
  const model = (text: string): PipelineModel & { complete: ReturnType<typeof vi.fn> } => {
    const complete = vi.fn(async () => ({ text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "m", costUsd: 0, ms: 1 }));
    return { name: "stub", complete } as never;
  };

  it("one call with the production prompt and schema, the answer checked", async () => {
    const m = model(JSON.stringify({ kind: "teams", lines: [], out: [] }));
    expect(await readHqSquadMessage(input("Here's the teams:\nNon Bibs\nFeroz"), ctx, { model: m })).toEqual({ kind: "teams" });
    expect(m.complete).toHaveBeenCalledTimes(1);
    const req = m.complete.mock.calls[0][0];
    expect(req.system).toBe(HQ_SQUAD_READER_SYSTEM);
    expect(req.schema).toEqual(HQ_SQUAD_READER_SCHEMA);
    expect(req.label).toBe("hq-squad-reader");
  });

  it("FAIL SAFE: no model, a failed call, an unreadable answer are all other", async () => {
    expect(await readHqSquadMessage(input("a\nb"), ctx, { model: null })).toMatchObject({ kind: "other" });
    const failing = { name: "x", complete: vi.fn(async () => { throw new Error("overloaded"); }) } as never;
    expect(await readHqSquadMessage(input("a\nb"), ctx, { model: failing })).toMatchObject({ kind: "other" });
    expect(await readHqSquadMessage(input("a\nb"), ctx, { model: model("not json") })).toMatchObject({ kind: "other" });
  });

  it("a sender who is nobody of the club: not asked", async () => {
    const m = model("{}");
    expect(await readHqSquadMessage(input("a\nb", { sender: { userId: null, name: null } }), ctx, { model: m })).toMatchObject({ kind: "other" });
    expect(m.complete).not.toHaveBeenCalled();
  });
});
