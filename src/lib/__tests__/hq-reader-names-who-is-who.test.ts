/**
 * HQ'S SQUAD READER NAMES, PLACED BY WHO-IS-WHO (review of #574, finding 2).
 *
 * The reader says what a message IS (a squad list, a change) and which
 * names it lists; it used to say who each name was too, with none of
 * who-is-who's safeguards ("an obvious misspelling" was the member; no
 * outsider ruling; no "not sure"). Now who-is-who is the one authority:
 * one call for the message, the reader's refs ignored for identity (the
 * sender's own place excepted), and "X for Y" with Y unplaced held whole.
 */
import { describe, expect, it } from "vitest";
import { placeReaderNames } from "../hq-squad-reader";
import { hqChangePeople } from "../admin-group-squad-change";
import type { HqSquadReaderContext, HqSquadReaderInput, HqSquadReading } from "../hq-squad-reader-prompt";
import type { PersonPick, PersonPicker, WhoRequest } from "../pipeline/who-is-who";

const ctx: HqSquadReaderContext = {
  orgId: "org",
  game: { label: "Mon 9 Nov, 20:30", places: 14 },
  members: [
    { ref: "p1", userId: "u-davide", name: "Davide De Sousa", aliases: ["davide"] },
    { ref: "p2", userId: "u-kemal", name: "Kemal", aliases: [] },
    { ref: "p3", userId: "u-najib", name: "Najib Sharif", aliases: [] },
    { ref: "p4", userId: "u-mo", name: "Mohammed Iqbal", aliases: [] },
  ],
  squad: { playing: ["u-davide", "u-kemal", "u-najib"], bench: [] },
  teams: null,
};
const input = (body: string): HqSquadReaderInput => ({ body, sender: { userId: "u-kemal", name: "Kemal" }, history: [], reply: null, now: new Date() });

function picker(answers: Record<string, PersonPick>) {
  const seen: WhoRequest[] = [];
  const pick: PersonPicker = async (req) => {
    seen.push(req);
    return {
      picks: new Map(req.messages.map((m) => [m.id, new Map(m.refs.map((r) => [r, answers[r] ?? { kind: "unidentified" as const, why: "no answer" }]))])),
      usage: null,
      degradations: [],
    };
  };
  return { pick, seen };
}

describe("a change: who-is-who overrules the reader's member refs", () => {
  it("THE INCIDENT in HQ: the reader read 'David' as Davide; who-is-who says nobody, so Davide is not moved", async () => {
    const reading: HqSquadReading = {
      kind: "change",
      changes: [{ name: "Davide De Sousa", written: "David", userId: "u-davide", to: "bench", replaces: "" }],
      alsoAsks: false,
    };
    const { pick, seen } = picker({ David: { kind: "none" } });
    const out = await placeReaderNames(reading, input("David - Kemal's son, is on the bench"), ctx, pick);
    expect(seen).toHaveLength(1);
    expect(seen[0].messages[0]).toMatchObject({ body: "David - Kemal's son, is on the bench", refs: ["David"] });
    expect(out).toMatchObject({ kind: "change", changes: [{ written: "David", name: "David", userId: null, to: "bench" }] });
    // As the engine reads it: "David" is nobody, never Davide.
    expect(hqChangePeople((out as Extract<HqSquadReading, { kind: "change" }>).changes).get("David")).toEqual({ kind: "none" });
  });

  it("a misspelling who-is-who is not sure of is unclear: never written, the sender is asked", async () => {
    const reading: HqSquadReading = {
      kind: "change",
      changes: [{ name: "Mohammed Iqbal", written: "Moh", userId: "u-mo", to: "in", replaces: "" }],
      alsoAsks: false,
    };
    const { pick } = picker({ Moh: { kind: "ambiguous", userIds: ["u-mo"] } });
    const out = (await placeReaderNames(reading, input("Moh in"), ctx, pick)) as Extract<HqSquadReading, { kind: "change" }>;
    expect(out.changes[0]).toMatchObject({ userId: null, unclear: true });
    expect(hqChangePeople(out.changes).get("Moh")).toEqual({ kind: "ambiguous", userIds: [] });
  });

  it("the sender's own place stays the sender's, and is not asked about", async () => {
    const reading: HqSquadReading = {
      kind: "change",
      changes: [{ name: "Kemal", written: "I", userId: "u-kemal", to: "out", replaces: "" }],
      alsoAsks: false,
    };
    const { pick, seen } = picker({});
    const out = (await placeReaderNames(reading, input("I'm out"), ctx, pick)) as Extract<HqSquadReading, { kind: "change" }>;
    expect(out.changes[0]).toMatchObject({ userId: "u-kemal" });
    expect(out.changes[0].unclear).toBeUndefined();
    expect(seen[0].messages[0].refs).toEqual([]);
  });

  // Round 3: the reader's pick of the SENDER is a pick like any other. Only
  // a self word ("I", "me", "ben") is the sender without asking; a NAME the
  // reader put on the sender goes to who-is-who, which may say otherwise.
  it("a written name the reader put on the sender is asked; who-is-who's answer stands", async () => {
    const reading: HqSquadReading = {
      kind: "change",
      changes: [{ name: "Kemal", written: "Kemal Jr", userId: "u-kemal", to: "in", replaces: "" }],
      alsoAsks: false,
    };
    const { pick, seen } = picker({ "Kemal Jr": { kind: "none" } });
    const out = (await placeReaderNames(reading, input("Kemal Jr is in"), ctx, pick)) as Extract<HqSquadReading, { kind: "change" }>;
    expect(seen[0].messages[0].refs).toEqual(["Kemal Jr"]);
    expect(out.changes[0]).toMatchObject({ userId: null, written: "Kemal Jr" });
  });

  it("the sender's own name, which who-is-who places on the sender, stays the sender's", async () => {
    const reading: HqSquadReading = {
      kind: "change",
      changes: [{ name: "Kemal", written: "Kemal", userId: "u-kemal", to: "out", replaces: "" }],
      alsoAsks: false,
    };
    const { pick } = picker({ Kemal: { kind: "member", userId: "u-kemal" } });
    const out = (await placeReaderNames(reading, input("Kemal out"), ctx, pick)) as Extract<HqSquadReading, { kind: "change" }>;
    expect(out.changes[0]).toMatchObject({ userId: "u-kemal" });
  });

  it("'X for Y' with Y unplaced holds the whole replacement (X is not added and Y left)", async () => {
    const reading: HqSquadReading = {
      kind: "change",
      changes: [{ name: "Mo", written: "Mo", userId: null, to: "in", replaces: "Najib Sharif", replacesUserId: "u-najib" }],
      alsoAsks: false,
    };
    const { pick } = picker({ Mo: { kind: "none" }, "Najib Sharif": { kind: "ambiguous", userIds: ["u-najib"] } });
    const out = (await placeReaderNames(reading, input("Mo instead of Najib"), ctx, pick)) as Extract<HqSquadReading, { kind: "change" }>;
    expect(out.changes[0]).toMatchObject({ unclear: true });
    expect(out.changes[0].replacesUserId).toBeUndefined();
  });
});

describe("a squad list: every line placed by who-is-who in one call", () => {
  it("member, nobody and unclear lines; the reader's refs ignored", async () => {
    const reading: HqSquadReading = {
      kind: "squad",
      lines: [
        { name: "Davide", userId: "u-davide", section: "playing" },
        { name: "David", userId: "u-davide", section: "playing" },
        { name: "Mo", userId: null, section: "bench" },
      ],
      out: [],
    };
    const { pick, seen } = picker({ Davide: { kind: "member", userId: "u-davide" }, David: { kind: "none" }, Mo: { kind: "ambiguous", userIds: ["u-mo"] } });
    const out = (await placeReaderNames(reading, input("1. Davide\n2. David\nBench\n3. Mo"), ctx, pick)) as Extract<HqSquadReading, { kind: "squad" }>;
    expect(seen).toHaveLength(1);
    expect(out.lines).toEqual([
      { name: "Davide", userId: "u-davide", section: "playing" },
      { name: "David", userId: null, section: "playing" },
      { name: "Mo", userId: null, section: "bench", unclear: true },
    ]);
  });

  it("a failed call leaves every line unclear: nobody written, nobody created", async () => {
    const reading: HqSquadReading = { kind: "squad", lines: [{ name: "Davide", userId: "u-davide", section: "playing" }], out: [] };
    const { pick } = picker({});
    const out = (await placeReaderNames(reading, input("1. Davide"), ctx, pick)) as Extract<HqSquadReading, { kind: "squad" }>;
    expect(out.lines[0]).toMatchObject({ userId: null, unclear: true });
  });
});
