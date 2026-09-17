/**
 * Three defects that are bugs TODAY, in English, for anyone whose name
 * starts with a Turkish capital or who writes a non-ASCII letter, fixed
 * as strict bug fixes with no behaviour change for ASCII input.
 * MDs/multi-language-design-2026-09-16.md section 7, items 1, 2 and 4.
 *
 *   1. `CLAIM_NAME` in group-copy.ts began `[A-Z]`. The patterns run
 *      with the `i` flag, so that class matched any ASCII letter but
 *      never Ç, Ğ, İ, Ö, Ş or Ü: "Çağrı goes on the bench" captured
 *      "ağrı", which matches nobody, so `contradictsSquadState` (the
 *      guard that stops the bot announcing a move the database never
 *      made) was blind to the sentence. Now `\p{Lu}`.
 *
 *   2. `bench-prompt-answer.ts`'s normaliser stripped every character
 *      outside `[a-z0-9\s]` AFTER NFD-folding, which deletes the dotless
 *      ı and every letter with no decomposition: "hayır" became "hay r"
 *      and a Turkish name was mangled before matching. Now `\p{L}\p{N}`.
 *      The word lists are NOT extended here (Phase 3b); this only stops
 *      the normaliser destroying the input.
 *
 *   4. Eight sites rendered a `Match.date` with date-fns' bare
 *      `format()`, which uses the SERVER's zone (UTC on Vercel), so for
 *      half the year the hour was one out. They now go through
 *      `formatLondon`. The design listed five; the grep found eight.
 *
 * Every ASCII case here renders byte for byte as before; the wider
 * English suites (`squad-state-composition.test.ts`,
 * `bench-prompt-answer.test.ts`) are untouched and stay green.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { format } from "date-fns";
import { contradictsSquadState, type SquadTruth } from "../group-copy";
import { normaliseBenchAnswerText, readBenchPromptAnswer } from "../bench-prompt-answer";
import { formatLondon } from "../london-time";

// ── 1. CLAIM_NAME accepts any Unicode uppercase initial ─────────────

describe("contradictsSquadState: a name with a Turkish capital is a name", () => {
  const truth: SquadTruth = {
    confirmed: ["Çağrı Demir", "Kemal Ediz", "Şükrü Aydın"],
    bench: ["İlkay Gündoğan", "Erdal Ozkan"],
    maxPlayers: 14,
    knownNames: ["Çağrı Demir", "Kemal Ediz", "Şükrü Aydın", "İlkay Gündoğan", "Erdal Ozkan", "Özgür Kaya"],
  };

  it("Ç: 'Çağrı goes on the bench' contradicts a CONFIRMED row", () => {
    expect(contradictsSquadState("Çağrı goes on the bench", truth)).toBe(true);
  });

  it("Ş: 'Şükrü is now out' contradicts a CONFIRMED row", () => {
    expect(contradictsSquadState("Şükrü is now out", truth)).toBe(true);
  });

  it("İ: 'İlkay is now in' contradicts a BENCH row", () => {
    expect(contradictsSquadState("İlkay is now in", truth)).toBe(true);
  });

  it("Ö: 'Özgür is now in' contradicts a known name with no row", () => {
    // Known to the group, no attendance row: a claim that he is in is
    // a move the database never made.
    expect(contradictsSquadState("Özgür is now in", truth)).toBe(true);
  });

  it("a Turkish-capital claim that AGREES with the rows is not a contradiction", () => {
    expect(contradictsSquadState("İlkay is on the bench", truth)).toBe(false);
    expect(contradictsSquadState("Çağrı is now confirmed", truth)).toBe(false);
  });

  it("ASCII names behave exactly as before (byte-identical inputs, same verdicts)", () => {
    expect(contradictsSquadState("Kemal goes on the bench", truth)).toBe(true);
    expect(contradictsSquadState("Erdal is now in", truth)).toBe(true);
    expect(contradictsSquadState("Erdal is on the bench", truth)).toBe(false);
    expect(contradictsSquadState("Adding Tuesday to the calendar", truth)).toBe(false);
  });
});

// ── 2. The bench-prompt normaliser keeps letters and digits ─────────

describe("bench-prompt normaliser: non-ASCII letters survive", () => {
  it("keeps the dotless ı and folds only the diacritics NFD can fold", () => {
    // Ç → C, ğ → g (both decompose); ı has no decomposition and used to
    // be deleted outright.
    expect(normaliseBenchAnswerText("Hayır Çağrı")).toBe("hayır cagrı");
  });

  it("a Turkish player's name is no longer mangled", () => {
    // ş folds to s (NFD), the dotless ı is kept, and the capital I
    // lower-cases to i under the default locale. Turkish-locale casing
    // (İ/I) is Phase 3b's decision; this pins that nothing is deleted.
    expect(normaliseBenchAnswerText("evet ben Işık")).toBe("evet ben isık");
  });

  it("ASCII input normalises byte for byte as before", () => {
    expect(normaliseBenchAnswerText("Yes mate!! I'm in")).toBe("yes mate im in");
    expect(normaliseBenchAnswerText("@Match Time yes")).toBe("yes");
    expect(normaliseBenchAnswerText("no 👎 sorry")).toBe("no sorry");
    expect(normaliseBenchAnswerText("count me in 2nite")).toBe("count me in 2nite");
  });

  it("the ASCII recogniser is unchanged: yes is yes, no is no, junk is null", () => {
    expect(readBenchPromptAnswer("yes")).not.toBeNull();
    expect(readBenchPromptAnswer("nah can't make it")).not.toBeNull();
    expect(readBenchPromptAnswer("what time is kickoff?")).toBeNull();
  });

  it("Turkish words survive the normaliser, so the word lists can read them", () => {
    // Phase 0 pinned "hayır" as unrecognised; Phase 1 (PR #90, same day)
    // added the Turkish vocabulary this normaliser change made possible.
    expect(normaliseBenchAnswerText("hayır")).toBe("hayır");
    expect(readBenchPromptAnswer("hayır")).toBe("no");
    expect(readBenchPromptAnswer("evet")).toBe("yes");
  });
});

// ── 4. Match dates render in London, never in the server's zone ─────

const ROOT = path.resolve(__dirname, "../../..");

/** The seven files holding the eight call sites: five sites from the
 *  design, three (matches.ts x2, players.ts) found by the grep. */
const FIXED_SITES = [
  "src/lib/dm-qa.ts",
  "src/lib/match-completion.ts",
  "src/lib/player-stats.ts",
  "src/app/api/whatsapp/status/route.ts",
  "src/app/api/whatsapp/teams/route.ts",
  "src/app/actions/matches.ts",
  "src/app/actions/players.ts",
];

describe("bare date-fns format() is gone from the match-date sites", () => {
  for (const rel of FIXED_SITES) {
    it(`${rel} imports no bare format from date-fns and uses formatLondon`, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*"date-fns"/);
      // `formatLondon` directly, or one of the per-language London labels
      // in `i18n/dates.ts` (Phase 3 moved the DM sites onto those; every
      // one of them is `formatLondon` underneath, see dates.test.ts).
      expect(src).toMatch(/\bformatLondon\(|\b(?:dayLabel|dayTimeLabel|dayCommaTimeLabel|longDayTimeLabel|kickoffLabel)\(/);
    });
  }

  it("why: a BST kickoff rendered by bare format() on a UTC server is an hour out", () => {
    // 21:30 London on a July evening is 20:30 UTC. `formatLondon` says
    // 21:30 wherever the process runs; bare `format` says whatever the
    // server's zone says, and Vercel's zone is UTC.
    const bst = new Date("2026-07-14T20:30:00.000Z");
    expect(formatLondon(bst, "EEE d MMM 'at' HH:mm")).toBe("Tue 14 Jul at 21:30");
    const prevTz = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      expect(format(bst, "HH:mm")).toBe("20:30");
      expect(formatLondon(bst, "HH:mm")).toBe("21:30");
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });
});
