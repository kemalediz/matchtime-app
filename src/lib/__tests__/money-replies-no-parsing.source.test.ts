/**
 * NO CODE READS WHAT THE COLLECTOR OR A PAYER MEANT (Kemal, 2026-10-30:
 * "I don't want any string parsing at all"; package P5 of the sweep).
 *
 * The collector's fee replies (✅, "yes", "£8 each", "£80 total") and a
 * player's "paid" are read by the model (`fee-confirm.ts`,
 * `payment-claim-classifier.ts`); code gates on facts only. Pinned here by
 * reading the sources:
 *
 *   1. the deleted parsers (`anchoredFeeReply`, `looksLikeFeeAmount`,
 *      `parseFeeReply`, their word sets and the Turkish unit and total
 *      regexes) are defined nowhere in production code and imported by
 *      nothing;
 *   2. the five money-reply files carry no regex, split, includes,
 *      startsWith or lower-casing outside an explicit list of lines that
 *      touch something other than a person's words (the model's JSON, our
 *      stub's label, a phone number, a stored name, our own enums).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
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
const prodFiles = walk(SRC).filter((f) => !isTest(f));

/** The source without comments, one entry per remaining code line. */
function codeLines(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1").trim())
    .filter(Boolean);
}

/** The deleted parsers, by their unique names, anywhere in production. */
export const DELETED_PARSER = /\b(?:function|const|let|var)\s+(anchoredFeeReply|looksLikeFeeAmount|parseFeeReply|TR_FEE_UNIT|AFFIRM_EMOJI|DENY_EMOJI)\b/;
const DELETED_IMPORT = /\b(anchoredFeeReply|looksLikeFeeAmount|parseFeeReply)\b/;

/** Anything that could inspect text, or look a word up in a set. */
const TEXT_TOOL = /\.has\(|new Set\b|\.split\(|\.match\(|\.matchAll\(|\.test\(|\.search\(|new RegExp|toLowerCase|toLocaleLowerCase|\.includes\(|\.startsWith\(|\.endsWith\(|\.replace\(|\.replaceAll\(|\.indexOf\(/;

/** The lines allowed to use one, each with what it touches. */
const ALLOWED: Record<string, string[]> = {
  "src/lib/fee-confirm.ts": [
    'const VALID: ReadonlySet<string> = new Set<FeeReply>(["yes", "no", "amount", "neither"]);', // the model's enum
    'const intent = typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as FeeReply) : "neither";',
    '.replace(/^```(?:json)?\\s*/i, "")', // the model's JSON fence
    '.replace(/\\s*```$/i, "")', // the model's JSON fence
    "const m = cleaned.match(/\\{[\\s\\S]*\\}/);", // the model's JSON
    'label?.trim().startsWith("{")', // the test stub's label
  ],
  "src/lib/payment-claim-classifier.ts": [
    'const VALID: ReadonlySet<string> = new Set<PaymentClaimIntent>(["paid", "paid_for_others", "will_pay_direct", "other"]);', // the model's enum
    'typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as PaymentClaimIntent) : "other";',
    '.replace(/^```(?:json)?\\s*/i, "")',
    '.replace(/\\s*```$/i, "")',
    "const m = cleaned.match(/\\{[\\s\\S]*\\}/);",
    'label?.trim().startsWith("{")',
  ],
  "src/lib/payment-flow.ts": [
    'phone: a.user.phoneNumber.replace(/^\\+/, ""),', // a phone number
  ],
  "src/lib/payments.ts": [
    'return availablePayMethods(org).includes("direct") ? text : null;', // our enum
    ".filter((m) => enabled.includes(m))", // our enum
  ],
  "src/lib/payment-claim.ts": [
    'const first = name?.trim().split(" ")[0];', // a stored name
  ],
};

describe("the money replies are read by the model, never by code", () => {
  it("no production file defines a deleted parser", () => {
    const offenders = prodFiles.filter((f) => codeLines(readFileSync(f, "utf8")).some((l) => DELETED_PARSER.test(l)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("no production file imports or calls a deleted parser", () => {
    const offenders = prodFiles.filter((f) => codeLines(readFileSync(f, "utf8")).some((l) => DELETED_IMPORT.test(l)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} inspects no text outside its listed lines`, () => {
      const hits = codeLines(readFileSync(path.join(ROOT, file), "utf8")).filter((l) => TEXT_TOOL.test(l));
      expect(hits.filter((l) => !allowed.includes(l))).toEqual([]);
    });
  }
});

describe("the guard itself", () => {
  it("catches a parser coming back in any form", () => {
    expect(DELETED_PARSER.test("export function anchoredFeeReply(text: string) {")).toBe(true);
    expect(TEXT_TOOL.test("const YES_WORDS = new Set(['yes']);")).toBe(true);
    expect(TEXT_TOOL.test("if (NO_WORDS.has(rest)) return 'no';")).toBe(true);
    expect(DELETED_PARSER.test("function looksLikeFeeAmount(t: string) {")).toBe(true);
    expect(TEXT_TOOL.test('if (/£/.test(text)) return true;')).toBe(true);
    expect(TEXT_TOOL.test("const isTotal = text.toLowerCase().includes('total');")).toBe(true);
  });
  it("ignores comments", () => {
    expect(codeLines("/* anchoredFeeReply */\n// parseFeeReply\nconst x = 1;")).toEqual(["const x = 1;"]);
  });
});
