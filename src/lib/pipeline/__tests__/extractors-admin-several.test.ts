/**
 * SEVERAL ADMIN ACTIONS IN ONE MESSAGE (Sutton FC, 2026-11-23 14:44).
 *
 * "@Match Time switch to 5aside, then invite local player pool for the
 * remaining slots" came back ONE action (`switch_format`): the prompt said
 * "THE ACTION, exactly one." The pool was never asked and nobody was told.
 *
 * The admin extractor now reports the LIST of actions the message asks
 * for, in the order asked (`actions`). Code runs them, one after the other
 * (`admin-ops-engine-batch.ts`). These pin the facts shape and what the
 * prompt must say; the model's behaviour is the paid check.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, factsSchemaFor, parseFacts } from "../extractors";
import type { AdminFacts } from "../types";

const P = EXTRACTOR_PROMPTS.admin;
const count = (needle: string) => P.split(needle).length - 1;

/** One step as the schema requires it: every field, empty unless given. */
const step = (o: Record<string, unknown>) => ({
  words: "",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  undo: false,
  matchDay: "",
  pastGame: false,
  phrase: "",
  remindAt: "",
  note: "",
  lookbackMatches: 0,
  playersFrom: [],
  clubRef: "",
  venueName: "",
  venueChoice: 0,
  breakMonths: [],
  playMonths: [],
  quietOff: false,
  quietFrom: "",
  quietTo: "",
  minPlayers: 0,
  maxPlayers: 0,
  fullTeams: false,
  openSquadOff: false,
  size: 0,
  aSide: false,
  game: 0,
  newDay: "",
  newTime: "",
  everyWeek: false,
  coverage: "",
  ...o,
});

const admin = (raw: unknown) => parseFacts("admin", JSON.stringify(raw), "m1").facts as AdminFacts;

describe("the admin facts: a list of actions, in the order asked", () => {
  it("the Sutton message: the switch first, then the pool, each a whole action, toMatchTime on each", () => {
    const f = admin({
      toMatchTime: true,
      actions: [
        step({ action: "switch_format", words: "switch to 5aside", size: 5, aSide: true }),
        step({ action: "recruit", words: "invite local player pool for the remaining slots", playersFrom: ["pool"] }),
      ],
    });
    expect(f).toMatchObject({ kind: "admin", action: "switch_format", size: 5, aSide: true, toMatchTime: true, words: "switch to 5aside" });
    expect(f.then).toHaveLength(1);
    expect(f.then![0]).toMatchObject({ kind: "admin", action: "recruit", pool: true, toMatchTime: true, words: "invite local player pool for the remaining slots" });
    expect(f.then![0]).not.toHaveProperty("size");
    expect(f.then![0]).not.toHaveProperty("then");
  });

  it("one action is exactly the facts it always was: no `then`", () => {
    const f = admin({ toMatchTime: true, actions: [step({ action: "switch_format", size: 8, aSide: true })] });
    expect(f).toMatchObject({ kind: "admin", action: "switch_format", size: 8, aSide: true, toMatchTime: true });
    expect(f).not.toHaveProperty("then");
  });

  it("the old flat shape (stubs, recorded answers) still reads as one action", () => {
    const f = admin({ ...step({ action: "recruit", playersFrom: ["pool"] }), toMatchTime: true });
    expect(f).toMatchObject({ kind: "admin", action: "recruit", pool: true, toMatchTime: true });
    expect(f).not.toHaveProperty("then");
  });

  it("no action at all is other", () => {
    expect(admin({ toMatchTime: false, actions: [] })).toMatchObject({ kind: "admin", action: "other" });
  });

  it("an 'other' beside a real action is kept, in its place, so code can say it was not done", () => {
    const f = admin({
      toMatchTime: true,
      actions: [step({ action: "cancel_match", matchDay: "Friday" }), step({ action: "other", words: "tell the bench" })],
    });
    expect(f.action).toBe("cancel_match");
    expect(f.then).toEqual([expect.objectContaining({ action: "other", words: "tell the bench" })]);
  });

  it("only 'other's are one 'other'", () => {
    const f = admin({ toMatchTime: true, actions: [step({ action: "other" }), step({ action: "other" })] });
    expect(f.action).toBe("other");
    expect(f).not.toHaveProperty("then");
  });

  it("an unknown action in the list is dropped with a degradation; the rest stand", () => {
    const r = parseFacts(
      "admin",
      JSON.stringify({ toMatchTime: true, actions: [step({ action: "launch_rocket" }), step({ action: "recruit", playersFrom: ["pool"] })] }),
      "m1",
    );
    expect(r.facts).toMatchObject({ kind: "admin", action: "recruit", pool: true });
    expect(r.degradations.map((d) => d.detail).join(" ")).toMatch(/unknown admin action "launch_rocket"/);
  });

  it("at most four actions are carried", () => {
    const f = admin({ toMatchTime: true, actions: Array.from({ length: 6 }, (_, i) => step({ action: "quiet_hours", words: `q${i}` })) });
    expect(1 + (f.then?.length ?? 0)).toBe(4);
  });
});

describe("the admin schema", () => {
  it("is a list of actions, each with its words, plus toMatchTime once for the message", () => {
    const s = factsSchemaFor("admin_ops") as { properties: Record<string, any>; required: string[] };
    expect(s.required.sort()).toEqual(["actions", "toMatchTime"]);
    const item = s.properties.actions.items;
    expect(item.required).toContain("action");
    expect(item.required).toContain("words");
    expect(item.properties).not.toHaveProperty("toMatchTime");
  });
});

describe("the admin prompt", () => {
  it("never says exactly one action any more", () => {
    expect(P).not.toMatch(/exactly one/i);
  });

  it("says once that a message may ask for several actions, listed in the order asked", () => {
    expect(count("THE ACTIONS, in the order asked.")).toBe(1);
  });

  it("defines `words` once", () => {
    expect(count("  words (every action):")).toBe(1);
  });

  it("shows the Sutton shape (a size switch, then the pool) without its exact words, EN and TR side by side", () => {
    expect(P).not.toContain("switch to 5aside, then invite local player pool");
    expect(P).toMatch(/-> switch_format, size \d, aSide true; then recruit, playersFrom \["pool"\]/);
    expect(P).toMatch(/\/ "@Match Time [^"\n]*havuz[^"\n]*" -> switch_format/);
  });

  it("shows a part MatchTime has no action for as 'other' in the list, not dropped", () => {
    expect(P).toMatch(/-> cancel_match[^\n]*; then other/);
  });
});
