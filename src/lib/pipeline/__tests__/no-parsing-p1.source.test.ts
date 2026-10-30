/**
 * NO STRING PARSING IN THE PLAYERS' GROUP PIPELINE CORE (Kemal,
 * 2026-10-30: "I don't want any string parsing at all"; package P1).
 *
 * The model reads a message, with the facts code has as context; code
 * gates only on FACTS (who sent it, the Pi's mention flag, a reply to
 * MatchTime, open questions, counts). Pinned here, by reading the
 * sources, so a later change cannot quietly bring a word test back:
 *
 *   1. the deleted parsers stay deleted: no production file defines or
 *      imports them (the bare IN/OUT floor in the router, the bench word
 *      list, the caption word list, the score-answer and correction
 *      vocabulary, the clarification name reader, the guest placeholder
 *      and offer cues, the group-address list, the reminder phrase
 *      vocabulary, the laughing-emoji banter test, the dead OUT safety net);
 *   2. `messageTagsBot` reads no text: only the structured flags;
 *   3. the retired floor and the score-shape helpers are deleted outright.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const isTest = (f: string) => /__tests__|\.test\.tsx?$/.test(f);
const prod = walk(SRC).filter((f) => !isTest(f));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const rel = (f: string) => path.relative(ROOT, f);

/** Code with comments removed, so a history note naming a deleted
 *  function is not mistaken for the function. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const CORE = [
  "src/lib/pipeline/router.ts",
  "src/lib/pipeline/gate.ts",
  "src/lib/pipeline/engine.ts",
  "src/lib/pipeline/score-ask.ts",
  "src/lib/pipeline/score-teams.ts",
  "src/lib/pipeline/awaiting-answer.ts",
  "src/lib/pipeline/identity.ts",
  "src/lib/pipeline/answer-batch.ts",
  "src/lib/pipeline/extractors.ts",
  "src/lib/attendance-engine-batch.ts",
  "src/lib/score-engine-batch.ts",
  "src/lib/guest-name-ask.ts",
  "src/lib/reminder-time.ts",
  "src/lib/picture-reading.ts",
  "src/lib/interaction-contract.ts",
  "src/lib/pipeline/load-awaiting-answer.ts",
];

describe("the deleted parsers stay deleted", () => {
  it("their files are gone", () => {
    for (const f of ["src/lib/pipeline/bench-words.ts", "src/lib/picture-words.ts", "src/lib/out-safety-net.ts"]) {
      expect(existsSync(path.join(ROOT, f)), f).toBe(false);
    }
  });

  it("no production file defines or calls them", () => {
    const GONE = [
      "namesTheBench",
      "BENCH_WORDS",
      "captionLooksAboutGame",
      "PICTURE_CAPTION_WORDS",
      "outSafetyNetSignals",
      "shouldForceSenderOut",
      "scoreAnswerRef",
      "scoreAnswerSide",
      "scorePairAnswerSide",
      "isScoreCorrectionText",
      "mayBeScoreCorrection",
      "clarificationSubject",
      "isPlaceholderGuestName",
      "looksLikeUnnamedGuestOffer",
      "stripPlaceholderGuests",
      "GROUP_ADDRESS",
      "resolveReminderPhrase",
      "floorForcesAnalysis",
      "isRouterFloorEnabled",
      "banterRefusal\\([^)]*\\)[^;]*😂",
    ];
    const hits: string[] = [];
    for (const f of prod) {
      const c = code(readFileSync(f, "utf8"));
      for (const name of GONE) if (new RegExp(`\\b${name}\\b`).test(c)) hits.push(`${rel(f)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("the pipeline core carries no laughing-emoji, question-mark or bot-name test on a message", () => {
    const hits: string[] = [];
    for (const f of CORE) {
      const c = code(read(f));
      if (/\/[^/\n]*(?:😂|🤣|lol\\b)[^/\n]*\/[a-z]*\.test\(/.test(c)) hits.push(`${f}: laughing markers`);
      if (/\/\[\?¿\]\/\.test\(/.test(c)) hits.push(`${f}: question mark test`);
      if (/match\\s\*time/.test(c) || /matchtime\\b/i.test(c)) hits.push(`${f}: bot name in a regex`);
    }
    expect(hits).toEqual([]);
  });
});

describe("the bot tag is facts only", () => {
  it("messageTagsBot reads the structured flags and never the body", () => {
    const src = code(read("src/lib/interaction-contract.ts"));
    const fn = src.slice(src.indexOf("export function messageTagsBot"), src.indexOf("export function messageMentionsBotExplicitly"));
    expect(fn).toMatch(/botMentioned === true/);
    expect(fn).toMatch(/quotedFromMatchTime === true/);
    expect(fn).toMatch(/routerAddressed === true/);
    expect(fn).not.toMatch(/\.body|\.test\(|RegExp/);
  });
});

describe("the retired floor is gone", () => {
  it("legacy-floor.ts is deleted and nothing names the floor's parsers", () => {
    expect(existsSync(path.join(ROOT, "src/lib/pipeline/legacy-floor.ts"))).toBe(false);
    for (const f of prod) {
      expect(code(readFileSync(f, "utf8")), rel(f)).not.toMatch(/\b(?:routeFloor|floorAttendanceFacts|parseFloor|bareDeclaration)\b/);
    }
  });

  it("the score-shape helpers HQ used are deleted", () => {
    for (const f of prod) {
      expect(code(readFileSync(f, "utf8")), rel(f)).not.toMatch(/\b(?:statesSeveralScorelines|hasScorelineShape|messageHasScoreline)\b/);
    }
  });
});

describe("no NEW reading of a message's words in these files (review of #476, L10)", () => {
  // Any regex, split, includes, match, test or replace on a message body,
  // text or caption. The only ones allowed are named here, each with why:
  // they check MODEL OUTPUT against the message, look the roster up to
  // give the model context, or read an attachment's format.
  const ALLOWED: Record<string, string> = {
    refWrittenIn: "a verifier: the name the model returned must be written in the message",
    numbersIn: "a verifier: the score the model returned must be numbers the sender wrote",
    membersNamedIn: "roster lookup: which club members' names appear, given to the model as context",
    asWritten: "roster lookup: an alias shown as the message wrote it",
    VCARD: "an attachment format marker (a shared contact card), not a person's words",
  };
  const BODY_PARSE =
    /(?:\b(?:msg|m|message|input|it|c)\.(?:body|text)\b|\bbody\b|\bcaption\b)[^;\n]{0,25}?\.(?:match|matchAll|split|includes|startsWith|endsWith|search|replace|test|exec)\(|\.(?:test|exec|match)\(\s*(?:(?:msg|m|message)\.)?(?:body|caption)\b/;

  /** The function a line sits in: the nearest "function NAME(" above it. */
  function enclosing(lines: string[], i: number): string {
    for (let k = i; k >= 0; k--) {
      const m = /function\s+(\w+)\s*\(/.exec(lines[k]);
      if (m) return m[1];
    }
    return "(top level)";
  }

  it("every hit is one of the allowed checks", () => {
    const hits: string[] = [];
    for (const f of CORE) {
      const lines = code(read(f)).split("\n");
      lines.forEach((l, i) => {
        if (!BODY_PARSE.test(l)) return;
        const fn = enclosing(lines, i);
        if (ALLOWED[fn] || (l.includes("BEGIN:VCARD") && ALLOWED.VCARD)) return;
        hits.push(`${f}:${i + 1} in ${fn}: ${l.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("interaction-contract.ts reads no body at all", () => {
    expect(code(read("src/lib/interaction-contract.ts"))).not.toMatch(/\.body\b[^;\n]*\.(?:test|match|includes|split|replace)\(|\/[^/\n]*match\\s\*time/i);
  });
});

