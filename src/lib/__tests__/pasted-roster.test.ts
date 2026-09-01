/**
 * The deterministic pasted-roster parser.
 *
 * RED FIRST. Every shape below was taken from real production traffic in
 * the Thursday group (org `cmplc3znw…`, groupRef `g-ab95248799`) or from
 * an incident already in the archive — not invented. The self-replay
 * sweep in PR #35 found that a pasted numbered roster registered a
 * DIFFERENT subset of names on two runs of an identical world; this
 * module is the code half of "the model extracts, code decides".
 */
import { describe, it, expect } from "vitest";
import {
  parsePastedRoster,
  isPastedRoster,
  rosterMentions,
  rosterMentionsAny,
  clampRosterDerivedWrites,
  reconcilePastedRoster,
} from "../pasted-roster";

/** The real 2026-06-11 message (Youssef, batch g-ab95248799:13:10:32).
 *  Note the U+2060 word-joiners WhatsApp leaves behind on a copy-paste,
 *  the shouted NABEEL, the "Yusuf.i" handle and the duplicated Adam. */
const REAL_20260611 = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo
6. ⁠ NABEEL
7. ⁠Talha
8. ⁠Yusuf.i
9. ⁠Amz
10. Youssef
11. ⁠Ersin
12. ⁠Omar
13. ⁠Adam
14. Arjun`;

/** The real 2026-06-07 seed (Adam Khandaza) — five names, no reserves. */
const REAL_20260607 = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo`;

/** The real 2026-06-10 paste — slot 14 left EMPTY after a drop-out. */
const REAL_20260610 = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo
6. ⁠ NABEEL
7. ⁠Talha
8. ⁠Yusuf.i
9. ⁠Amz
10. Youssef
11. ⁠Ersin
12. ⁠Omar
13. ⁠Adam
14.`;

describe("parsePastedRoster — the shapes that actually occur", () => {
  it("parses the real 2026-06-11 paste: 14 slots, names cleaned, order kept", () => {
    const r = parsePastedRoster(REAL_20260611);
    expect(r).not.toBeNull();
    expect(r!.names).toEqual([
      "Ehtisham",
      "Amir",
      "Martin",
      "Adam",
      "Mo",
      "NABEEL",
      "Talha",
      "Yusuf.i",
      "Amz",
      "Youssef",
      "Ersin",
      "Omar",
      "Adam",
      "Arjun",
    ]);
  });

  it("parses the real 2026-06-07 five-name seed", () => {
    const r = parsePastedRoster(REAL_20260607);
    expect(r!.names).toEqual(["Ehtisham", "Amir", "Martin", "Adam", "Mo"]);
  });

  it("an EMPTY numbered slot yields no name (2026-06-10 slot 14)", () => {
    const r = parsePastedRoster(REAL_20260610);
    expect(r!.entries).toHaveLength(14);
    expect(r!.entries[13].name).toBe("");
    expect(r!.names).toHaveLength(13);
  });

  it("keeps DUPLICATES rather than silently collapsing them", () => {
    const r = parsePastedRoster(REAL_20260611);
    expect(r!.names.filter((n) => n === "Adam")).toHaveLength(2);
  });

  it("bulleted lists count as rosters", () => {
    const r = parsePastedRoster("- Adam\n- Amir\n- Martin\n- Mo\n• Talha");
    expect(r!.names).toEqual(["Adam", "Amir", "Martin", "Mo", "Talha"]);
  });

  it("mixed numbering styles in one message", () => {
    const r = parsePastedRoster("1. Adam\n2) Amir\n3 - Martin\n4: Mo\n5. Talha");
    expect(r!.names).toEqual(["Adam", "Amir", "Martin", "Mo", "Talha"]);
  });

  it("emoji digits", () => {
    const r = parsePastedRoster("1️⃣ Adam\n2️⃣ Amir\n3️⃣ Martin\n4️⃣ Mo");
    expect(r!.names).toEqual(["Adam", "Amir", "Martin", "Mo"]);
  });

  it("strips emoji and trailing notes from a name", () => {
    const r = parsePastedRoster(
      "1. Adam ⚽\n2. Amir (GK)\n3. Martin - maybe late\n4. Mo 🔥🔥",
    );
    expect(r!.names).toEqual(["Adam", "Amir", "Martin", "Mo"]);
  });

  it("strips the WhatsApp `~` pushname prefix", () => {
    const r = parsePastedRoster("1. ~Adam\n2. ~T\n3. Martin\n4. Mo");
    expect(r!.names).toEqual(["Adam", "T", "Martin", "Mo"]);
  });

  it("a Reserves / Subs block is parsed separately, never as playing names", () => {
    const r = parsePastedRoster(
      "1. Adam\n2. Amir\n3. Martin\n4. Mo\n\nReserves:\n1. Talha\n2. Arjun",
    );
    expect(r!.names).toEqual(["Adam", "Amir", "Martin", "Mo"]);
    expect(r!.reserves.map((e) => e.name)).toEqual(["Talha", "Arjun"]);
  });

  it("@lid / raw-digit wire-format entries never become names (S28 Izzet/Elnur)", () => {
    const r = parsePastedRoster(
      "1. @158055467598020\n2. 189206211076115@lid\n3. 447700900123@c.us\n4. Adam\n5. Amir\n6. Martin",
    );
    expect(r!.names).toEqual(["Adam", "Amir", "Martin"]);
    expect(r!.entries.slice(0, 3).every((e) => e.name === "" && !e.nameLike)).toBe(true);
  });

  it("a name that is also an ordinary word survives as a name", () => {
    const r = parsePastedRoster("1. Will\n2. Mark\n3. Grant\n4. Mo");
    expect(r!.names).toEqual(["Will", "Mark", "Grant", "Mo"]);
  });
});

describe("isPastedRoster — what must NOT be treated as a roster", () => {
  it("a bare IN is not a roster", () => {
    expect(isPastedRoster("in")).toBe(false);
    expect(isPastedRoster("I'm in for tonight lads")).toBe(false);
  });

  it("inline numbers in prose are not a roster", () => {
    expect(isPastedRoster("I can do 1. or 2. tonight, either works")).toBe(false);
  });

  it("three numbered lines are not enough", () => {
    expect(isPastedRoster("1. Adam\n2. Amir\n3. Martin")).toBe(false);
  });

  it("a numbered instruction list is not a roster (no bare names)", () => {
    expect(
      isPastedRoster(
        "@Match Time please do:\n1. add Kieran to the squad\n2. drop Amir from tonight\n" +
          "3. show me the teams for tomorrow\n4. remind everyone about the fee",
      ),
    ).toBe(false);
  });

  it("a leaderboard answer is not a roster", () => {
    expect(
      isPastedRoster(
        "1. Adam — 4/4 (100%)\n2. Amir — 3/4 (75%)\n3. Martin — 3/4 (75%)\n4. Mo — 2/4 (50%)",
      ),
    ).toBe(false);
  });
});

describe("a pasted list that is NOT a roster of people", () => {
  // The parser cannot know a shopping list from a squad without a
  // dictionary, and it deliberately does not try. It reports the SHAPE.
  // Safety comes from the direction of the clamp: a false positive can
  // only ever REMOVE a write, never add one — no shopping-list item can
  // match a registerFor name or a sender.
  const SHOPPING = "1. milk\n2. bread\n3. eggs\n4. rice\n5. chicken";

  it("is reported as list-shaped (honest about the limit)", () => {
    expect(isPastedRoster(SHOPPING)).toBe(true);
  });

  it("matches nobody, so the clamp removes nothing", () => {
    const r = parsePastedRoster(SHOPPING)!;
    expect(rosterMentions(r, "Adam")).toBe(false);
    expect(rosterMentions(r, "Kieran")).toBe(false);
    expect(rosterMentionsAny(r, ["Adam Khandaza", "Adam"])).toBe(false);
  });
});

describe("rosterMentions — matching a verdict name to a slot", () => {
  const r = parsePastedRoster(REAL_20260611)!;

  it("matches an exact entry", () => {
    expect(rosterMentions(r, "Amz")).toBe(true);
    expect(rosterMentions(r, "Arjun")).toBe(true);
    expect(rosterMentions(r, "Yusuf.i")).toBe(true);
  });

  it("matches case- and diacritic-insensitively", () => {
    expect(rosterMentions(r, "nabeel")).toBe(true);
    expect(rosterMentions(r, "NABEEL")).toBe(true);
  });

  it("matches a fuller DB name against a first-name slot", () => {
    // The slot says "Ehtisham"; the resolved member is "Ehtisham Ul Haq".
    expect(rosterMentions(r, "Ehtisham Ul Haq")).toBe(true);
    expect(rosterMentions(r, "Ersin Sevindik")).toBe(true);
  });

  it("matches when the model PARAPHRASES the slot's punctuation", () => {
    // 2026-06-10, after the first cut of this clamp shipped: the list
    // says "8. Yusuf.i", the model emitted registerFor "Yusuf", the
    // write slipped through and provisioned a ghost member called
    // "Yusuf". Matching has to fold the punctuation a handle carries.
    expect(rosterMentions(r, "Yusuf")).toBe(true);
    expect(rosterMentions(r, "Yusuf I")).toBe(true);
  });

  it("does NOT match on a substring or a different first name", () => {
    expect(rosterMentions(r, "Am")).toBe(false);
    expect(rosterMentions(r, "Adamu Bello")).toBe(false);
  });

  it("does NOT match someone absent from the list", () => {
    expect(rosterMentions(r, "Kieran")).toBe(false);
    expect(rosterMentions(r, "Trevell")).toBe(false);
    expect(rosterMentions(r, "Rashad")).toBe(false);
  });

  it("never matches an empty or whitespace name", () => {
    expect(rosterMentions(r, "")).toBe(false);
    expect(rosterMentions(r, "   ")).toBe(false);
  });

  it("rosterMentionsAny takes the sender's several known names", () => {
    expect(rosterMentionsAny(r, [null, undefined, "Youssef"])).toBe(true);
    expect(rosterMentionsAny(r, [null, "Kemal"])).toBe(false);
  });
});

describe("reconcilePastedRoster — the one shape that IS a registration", () => {
  /** S26 (`4cbdd05`, 2026-04-24). A member forwards MatchTime's own
   *  roster post with the open slots filled in. The confirmed squad is
   *  restated in Match Context ORDER and the new names are appended, so
   *  "which lines are new" is arithmetic, not a judgement call. */
  const S26_CONFIRMED = [
    "Kemal Ediz",
    "Elvin Aliyev",
    "Sait Demir",
    "Mustafa Kaya",
    "Abid Hussain",
    "Idris Bello",
    "Faris Nasser",
    "Shaz Iqbal",
    "Adam Osman",
    "Efat Rahman",
    "Usama Tariq",
    "Karahan Yildiz",
  ];
  const S26_PASTE = `${S26_CONFIRMED.map((n, i) => `${i + 1}. ${n}`).join("\n")}
13. Zair Malik
14. Wasim Akhtar`;

  it("a forwarded MatchTime roster registers EXACTLY the appended names", () => {
    const r = reconcilePastedRoster(parsePastedRoster(S26_PASTE), S26_CONFIRMED);
    expect(r.ofRecord).toBe(true);
    expect(r.additions).toEqual(["Zair Malik", "Wasim Akhtar"]);
  });

  it("re-listing the squad with nothing appended registers nobody", () => {
    const body = S26_CONFIRMED.map((n, i) => `${i + 1}. ${n}`).join("\n");
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED);
    expect(r.ofRecord).toBe(true);
    expect(r.additions).toEqual([]);
  });

  it("first names in the list still match fuller member records", () => {
    const body = "1. Kemal\n2. Elvin\n3. Sait\n4. Mustafa\n5. Zair Malik";
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED.slice(0, 4));
    expect(r.ofRecord).toBe(true);
    expect(r.additions).toEqual(["Zair Malik"]);
  });

  it("an EMPTY squad is never of record — any list restates nothing", () => {
    // 2026-06-07: 0 confirmed of 14, two members paste a five- and a
    // six-name list. With nothing to restate there is no evidence the
    // paste is THIS match's roster, and a shopping list would qualify.
    const r = reconcilePastedRoster(parsePastedRoster(REAL_20260607), []);
    expect(r.ofRecord).toBe(false);
    expect(r.reason).toBe("no-confirmed-squad");
    expect(r.additions).toEqual([]);
  });

  it("a list in the GROUP's own order is not of record (2026-06-11)", () => {
    // Confirmed order is Ehtisham, Amir, Nabeel, …; the paste runs
    // Ehtisham, Amir, Martin, …. Slot 3 disagrees, so this is the
    // group's own ritual list, not a forward of MatchTime's post.
    const r = reconcilePastedRoster(parsePastedRoster(REAL_20260611), [
      "Ehtisham Ul Haq",
      "Amir",
      "Nabeel",
      "Martin",
      "Mo",
      "Talha",
      "Youssef",
      "Ersin Sevindik",
      "Omar Yusuf",
      "Adam Khandaza",
    ]);
    expect(r.ofRecord).toBe(false);
    expect(r.reason).toBe("prefix-mismatch");
    expect(r.additions).toEqual([]);
  });

  it("2026-06-10 is not of record either — slot 2 is Amir, the squad's is Nabeel", () => {
    const r = reconcilePastedRoster(parsePastedRoster(REAL_20260610), [
      "Ehtisham Ul Haq",
      "Nabeel",
    ]);
    expect(r.ofRecord).toBe(false);
    expect(r.reason).toBe("prefix-mismatch");
  });

  it("a list SHORTER than the confirmed squad is not of record", () => {
    const body = "1. Kemal Ediz\n2. Elvin Aliyev\n3. Sait Demir\n4. Mustafa Kaya";
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED);
    expect(r.ofRecord).toBe(false);
    expect(r.reason).toBe("prefix-mismatch");
  });

  it("appended blanks and drum rows add nobody", () => {
    const body = `1. Kemal Ediz\n2. Elvin Aliyev\n3. Sait Demir\n4. Mustafa Kaya\n5. 🥁\n6.`;
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED.slice(0, 4));
    expect(r.ofRecord).toBe(true);
    expect(r.additions).toEqual([]);
  });

  it("an appended name repeated twice is added once", () => {
    const body =
      "1. Kemal Ediz\n2. Elvin Aliyev\n3. Sait Demir\n4. Mustafa Kaya\n5. Zair Malik\n6. Zair";
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED.slice(0, 4));
    expect(r.additions).toEqual(["Zair Malik"]);
  });

  it("a name already confirmed is never re-registered, wherever it appears", () => {
    const body =
      "1. Kemal Ediz\n2. Elvin Aliyev\n3. Sait Demir\n4. Mustafa Kaya\n5. Kemal\n6. Zair Malik";
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED.slice(0, 4));
    expect(r.additions).toEqual(["Zair Malik"]);
  });

  it("a message that is not list-shaped is never of record", () => {
    const r = reconcilePastedRoster(parsePastedRoster("Add Rashad please"), S26_CONFIRMED);
    expect(r.ofRecord).toBe(false);
    expect(r.reason).toBe("not-a-roster");
  });

  it("RESERVES are never additions — a bench block is not a squad slot", () => {
    const body =
      "1. Kemal Ediz\n2. Elvin Aliyev\n3. Sait Demir\n4. Mustafa Kaya\n5. Zair Malik\n\nReserves:\n1. Wasim Akhtar";
    const r = reconcilePastedRoster(parsePastedRoster(body), S26_CONFIRMED.slice(0, 4));
    expect(r.additions).toEqual(["Zair Malik"]);
  });
});

describe("clampRosterDerivedWrites — the write-level clamp", () => {
  const IN = "IN" as const;

  it("is a no-op on a message that is not list-shaped", () => {
    const out = clampRosterDerivedWrites({
      body: "Add Rashad please",
      senderNames: ["Adam Khandaza"],
      registerAttendance: null,
      registerFor: [{ name: "Rashad", action: IN }],
    });
    expect(out.applied).toBe(false);
    expect(out.registerFor).toEqual([{ name: "Rashad", action: IN }]);
    expect(out.silenced).toBe(false);
  });

  it("drops every registerFor name that came out of the list", () => {
    const out = clampRosterDerivedWrites({
      body: REAL_20260611,
      senderNames: ["Youssef"],
      registerAttendance: null,
      // exactly what one of the two self-replay runs emitted
      registerFor: [
        { name: "Amz", action: IN },
        { name: "Arjun", action: IN },
        { name: "Yusuf.i", action: IN },
      ],
    });
    expect(out.applied).toBe(true);
    expect(out.registerFor).toBeNull();
    expect(out.droppedNames).toEqual(["Amz", "Arjun", "Yusuf.i"]);
    expect(out.silenced).toBe(true);
  });

  it("the OTHER run's output clamps to exactly the same thing", () => {
    const out = clampRosterDerivedWrites({
      body: REAL_20260611,
      senderNames: ["Youssef"],
      registerAttendance: null,
      registerFor: [
        { name: "Amz", action: IN },
        { name: "Arjun", action: IN },
      ],
    });
    expect(out.registerFor).toBeNull();
    expect(out.silenced).toBe(true);
  });

  it("KEEPS a genuine add whose name is not in the list", () => {
    const out = clampRosterDerivedWrites({
      body: `${REAL_20260607}\n\nalso adding Kieran`,
      senderNames: ["Adam Khandaza"],
      registerAttendance: null,
      registerFor: [
        { name: "Kieran", action: IN },
        { name: "Amir", action: IN },
      ],
    });
    expect(out.registerFor).toEqual([{ name: "Kieran", action: IN }]);
    expect(out.droppedNames).toEqual(["Amir"]);
    expect(out.silenced).toBe(false);
  });

  it("drops a self IN when the sender's own name is a slot in the list", () => {
    const out = clampRosterDerivedWrites({
      body: REAL_20260607,
      senderNames: ["Adam Khandaza", "Adam"],
      registerAttendance: IN,
      registerFor: null,
    });
    expect(out.registerAttendance).toBeNull();
    expect(out.droppedSelf).toBe(true);
    expect(out.silenced).toBe(true);
  });

  it("KEEPS a self IN when the sender is NOT in the list — that came from prose", () => {
    const out = clampRosterDerivedWrites({
      body: `I'm in\n${REAL_20260607}`,
      senderNames: ["Kemal"],
      registerAttendance: IN,
      registerFor: null,
    });
    expect(out.registerAttendance).toBe("IN");
    expect(out.droppedSelf).toBe(false);
  });

  it("NEVER strips an OUT — the clamp only ever removes additions", () => {
    const out = clampRosterDerivedWrites({
      body: REAL_20260607,
      senderNames: ["Adam Khandaza", "Adam"],
      registerAttendance: "OUT",
      registerFor: null,
    });
    expect(out.registerAttendance).toBe("OUT");
    expect(out.droppedSelf).toBe(false);
    expect(out.silenced).toBe(false);
  });

  it("strips a BENCH self-registration the same way as an IN", () => {
    const out = clampRosterDerivedWrites({
      body: REAL_20260607,
      senderNames: ["Adam"],
      registerAttendance: "BENCH",
      registerFor: null,
    });
    expect(out.registerAttendance).toBeNull();
  });

  it("a shopping list clamps nothing — nothing in it matches a person", () => {
    const out = clampRosterDerivedWrites({
      body: "1. milk\n2. bread\n3. eggs\n4. rice\n5. chicken",
      senderNames: ["Adam Khandaza"],
      registerAttendance: IN,
      registerFor: [{ name: "Kieran", action: IN }],
    });
    expect(out.applied).toBe(true);
    expect(out.registerAttendance).toBe("IN");
    expect(out.registerFor).toEqual([{ name: "Kieran", action: IN }]);
    expect(out.silenced).toBe(false);
  });

  it("an @lid slot can never clamp anything (S28)", () => {
    const out = clampRosterDerivedWrites({
      body: "1. @158055467598020\n2. Adam\n3. Amir\n4. Martin\n5. Mo",
      senderNames: ["158055467598020"],
      registerAttendance: IN,
      registerFor: [{ name: "158055467598020", action: IN }],
    });
    expect(out.registerAttendance).toBe("IN");
    expect(out.registerFor).toEqual([{ name: "158055467598020", action: IN }]);
  });

  it("is MONOTONE: it can only ever remove writes, never add one", () => {
    const before = {
      body: REAL_20260611,
      senderNames: ["Youssef"],
      registerAttendance: IN,
      registerFor: [
        { name: "Amz", action: IN },
        { name: "Kieran", action: IN },
      ],
    };
    const out = clampRosterDerivedWrites(before);
    const kept = out.registerFor ?? [];
    expect(kept.every((e) => before.registerFor.some((b) => b.name === e.name))).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(before.registerFor.length);
    expect([null, before.registerAttendance]).toContain(out.registerAttendance);
  });

  it("is IDEMPOTENT — clamping a clamped verdict changes nothing", () => {
    const once = clampRosterDerivedWrites({
      body: REAL_20260611,
      senderNames: ["Youssef"],
      registerAttendance: IN,
      registerFor: [{ name: "Amz", action: IN }],
    });
    const twice = clampRosterDerivedWrites({
      body: REAL_20260611,
      senderNames: ["Youssef"],
      registerAttendance: once.registerAttendance,
      registerFor: once.registerFor,
    });
    expect(twice.registerAttendance).toBe(once.registerAttendance);
    expect(twice.registerFor).toEqual(once.registerFor);
  });
});
