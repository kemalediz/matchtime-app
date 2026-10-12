/**
 * One word for one thing (owner decision, 2026-10-12): a player who wants
 * to play when the squad is full is "on the bench". MatchTime's own words
 * never call that a "waiting list", "reserves" or a "standby list", and
 * the Turkish is always a form of "yedek".
 *
 * This reads the SOURCE of the two string files rather than rendering the
 * strings, so every branch of every function is covered, not only the
 * branch a sample argument happens to take. Comment lines are ignored.
 *
 * What players TYPE is a different matter and is not checked here:
 * `pipeline/bench-words.ts` and the pasted-list readers keep accepting
 * "reserve", "standby", "waiting list" and the rest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..");

/** Whole-line comments: a line comment, or a line of a block comment.
 *  A WhatsApp bold line inside a template starts with a star and a word,
 *  with no space between, so it is still read as copy. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/|\*\s|\*$)/;
/** A top-level key of the strings object: two spaces, a name, a colon. */
const TOP_LEVEL_KEY = /^ {2}([A-Za-z_]\w*)\s*:/;

interface Hit {
  key: string;
  line: number;
  text: string;
}

function scan(file: string, banned: RegExp): Hit[] {
  const hits: Hit[] = [];
  let key = "(before the first key)";
  readFileSync(join(DIR, file), "utf8")
    .split("\n")
    .forEach((text, i) => {
      if (COMMENT_LINE.test(text)) return;
      const m = TOP_LEVEL_KEY.exec(text);
      if (m) key = m[1];
      if (banned.test(text)) hits.push({ key, line: i + 1, text: text.trim() });
    });
  return hits;
}

function offenders(hits: Hit[], allowed: Record<string, string>): string[] {
  return hits.filter((h) => !(h.key in allowed)).map((h) => `${h.key} (line ${h.line}): ${h.text}`);
}

describe("the bench is called the bench (English)", () => {
  /** Keys that keep an old word, each with the reason. Add a key here only
   *  when the text is NOT about a player waiting for a place in a match. */
  const ALLOWED: Record<string, string> = {
    // The section title of the monthly list, which members copy, edit and
    // paste back. It is in the list reader's own vocabulary (RESERVE_HEADER
    // in pasted-roster.ts) and it also heads the MONTH's queue for a
    // regular place on the sign-up post, which is not the weekly bench.
    // Left for the owner to decide (see the PR that added this test).
    mwk_list_reserves: "the pasted monthly list's section title, read back by the list reader",
  };
  const BANNED = /wait(?:ing)?[\s-]?list|\breserves?\b|stand-?by|\bsub(?:s|stitutes?)? list/i;

  it("no 'waiting list', 'reserve', 'standby' or 'sub list' outside the allow-list", () => {
    expect(offenders(scan("strings.en.ts", BANNED), ALLOWED)).toEqual([]);
  });

  it("the scan does find the word where it is allowed, so it is really reading the file", () => {
    const keys = scan("strings.en.ts", BANNED).map((h) => h.key);
    expect(keys).toEqual(Object.keys(ALLOWED));
  });
});

describe("the bench is always 'yedek' (Turkish)", () => {
  /** Nothing is allowed today. */
  const ALLOWED: Record<string, string> = {};
  /** The competing ways of saying it: "bekleme listesi" (waiting list),
   *  "sıraya almak" (to queue somebody) and "rezerv". */
  const BANNED = /bekleme\s+listesi|sıraya\s+al|\brezerv(?!asyon)/i;

  it("no 'bekleme listesi', 'sıraya al...' or 'rezerv'", () => {
    expect(offenders(scan("strings.tr.ts", BANNED), ALLOWED)).toEqual([]);
  });

  it("and the word it does use is there", () => {
    expect(scan("strings.tr.ts", /yedek/i).length).toBeGreaterThan(20);
  });
});
