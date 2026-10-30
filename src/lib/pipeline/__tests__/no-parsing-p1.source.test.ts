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
 *   3. the retired floor survives only in `legacy-floor.ts`, for its last
 *      importer in the HQ package, and nothing in the pipeline core
 *      imports it (the manager deletes it when that importer is gone).
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

describe("the retired floor lives only in legacy-floor.ts, for the HQ importer", () => {
  it("no pipeline-core file imports legacy-floor", () => {
    for (const f of CORE.filter((x) => x !== "src/lib/pipeline/router.ts")) {
      expect(read(f), f).not.toMatch(/legacy-floor/);
    }
  });

  it("the router only re-exports it, and never calls it", () => {
    const c = code(read("src/lib/pipeline/router.ts"));
    expect(c).toMatch(/export \{ floorAttendanceFacts, routeFloor \} from "\.\/legacy-floor";/);
    expect(c).not.toMatch(/\b(?:routeFloor|floorAttendanceFacts|parseFloor|bareDeclaration)\(/);
  });

  it("the attendance engine does not read floor facts at the cap", () => {
    expect(code(read("src/lib/attendance-engine-batch.ts"))).not.toMatch(/floorAttendanceFacts/);
  });
});
