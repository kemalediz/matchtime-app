/**
 * THE REPO-WIDE GUARD: MatchTime never says an em dash or an en dash.
 *
 * Kemal, 2026-10-06: "remove long dashes". Every sentence MatchTime says
 * to a person was rewritten that day (a comma, a colon, a full stop or
 * brackets, never a bare hyphen swap), and this file keeps it that way:
 *
 *   1. THE STRING TABLES. No string in `strings.en.ts` or `strings.tr.ts`
 *      carries one. Read from the SOURCE, not from a rendered sample, so
 *      every branch of every entry is covered (a rendered sample only
 *      ever shows one day of the rating reminder).
 *   2. THE PAGES. No string or text in any `.tsx` under `src/app` or
 *      `src/components` carries one, as a character, an escape or an
 *      HTML entity.
 *   3. THE COPY MODULES. The `.ts` files that hold fixed wording outside
 *      the tables (server actions, the scheduler's notices, the DMs).
 *   4. THE MODEL'S WORDS. Anything a model composes passes through
 *      `applyHouseStyle` / `stripLongDashes` (`../house-style`), and its
 *      output never carries one, whatever went in.
 *
 * WHAT IS ALLOWED TO KEEP ONE, AND WHY. A prompt is not a message: the
 * text sent TO a model is out of this rule's reach, because changing a
 * prompt needs a paid live check (CLAUDE.md, "live-LLM suites need
 * Kemal's approval"). Two strings in the guarded files are prompt text
 * and are listed in `PROMPT_BOUND` below, each with its reason. Adding
 * to that list is a decision, not a way to make this test pass: a new
 * user-facing sentence with a dash in it is fixed by rewriting it.
 *
 * Comments, logs (`console.*`) and regular expressions are not checked.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { applyHouseStyle, hasLongDash, stripLongDashes } from "@/lib/house-style";

const ROOT = path.resolve(__dirname, "../../..");
const LONG_DASH = /[—–]|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/i;

/**
 * Prompt text living in a guarded file. `file` is repo-relative, `owner`
 * is the entry or function that holds the string, `count` is how many of
 * its string pieces carry a dash.
 */
const PROMPT_BOUND: { file: string; owner: string; count: number; why: string }[] = [
  {
    file: "src/lib/i18n/strings.en.ts",
    owner: "dm_fee_confirm_prompt",
    count: 1,
    why:
      "fee-confirm.ts quotes this very question inside the fee-reply model's prompt " +
      "(feeConfirmQuestionForPrompt in dm-copy.ts), built from this entry so the two cannot drift. " +
      "Changing it changes that prompt.",
  },
  {
    file: "src/lib/bench-offer-copy.ts",
    owner: "benchClaimPhrasingExample",
    count: 1,
    why: "a phrasing example handed to the chase composer's prompt, not a message anyone is sent.",
  },
];

interface Hit {
  file: string;
  line: number;
  owner: string;
  text: string;
}

/**
 * What a string belongs to: the function it is written in, or else the
 * outermost object entry around it (in a string table, the entry's key).
 */
function ownerOf(node: ts.Node): string {
  let entry: string | null = null;
  let fn: string | null = null;
  let variable: string | null = null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if ((ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
      entry = n.name.text;
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      fn ??= n.name.text;
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      variable = n.name.text;
    }
  }
  return fn ?? entry ?? variable ?? "(top level)";
}

/** Inside the arguments of `console.log(...)` and friends: a log line. */
function isLogArgument(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "console"
    ) {
      return true;
    }
  }
  return false;
}

/** Every string, template piece and JSX text in a file that carries a
 *  long dash. Comments are not nodes, so they are never seen. */
function longDashStrings(file: string): Hit[] {
  const abs = path.join(ROOT, file);
  const source = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(
    abs,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (isText && !isLogArgument(node)) {
      // The written form (catches an HTML entity) and the value (catches
      // a "—" escape).
      const written = node.getText(sf);
      const value = (node as ts.StringLiteralLike).text ?? "";
      if (LONG_DASH.test(written) || LONG_DASH.test(value)) {
        hits.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          owner: ownerOf(node),
          text: written.trim().slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Hits that are not on the prompt-bound list. An allowance is spent per
 *  string, so a second dash in an allowed entry still fails. */
function unexpected(hits: Hit[]): string[] {
  const left = new Map(PROMPT_BOUND.map((a) => [`${a.file}#${a.owner}`, a.count]));
  const out: string[] = [];
  for (const h of hits) {
    const key = `${h.file}#${h.owner}`;
    const n = left.get(key) ?? 0;
    if (n > 0) left.set(key, n - 1);
    else out.push(`${h.file}:${h.line} (${h.owner}) ${h.text}`);
  }
  return out;
}

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules" || e.name === "generated") continue;
      out.push(...walk(rel, keep));
    } else if (keep(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

const TABLES = ["src/lib/i18n/strings.en.ts", "src/lib/i18n/strings.tr.ts"];

const PAGES = [...walk("src/app", (n) => n.endsWith(".tsx")), ...walk("src/components", (n) => n.endsWith(".tsx"))];

/**
 * Fixed wording that lives outside the tables. Not every `.ts` file can
 * be on this list: many hold prompts or operator diagnostics, which are
 * not messages. These are the ones that only hold things people read.
 */
const COPY_MODULES = [
  ...walk("src/app/actions", (n) => n.endsWith(".ts")),
  "src/app/api/whatsapp/group-leave/route.ts",
  "src/lib/attendance.ts",
  "src/lib/bench-offer-copy.ts",
  "src/lib/block-booking.ts",
  "src/lib/bot-scheduler.ts",
  "src/lib/dm-copy.ts",
  "src/lib/group-copy.ts",
  "src/lib/info-copy.ts",
  "src/lib/london-time.ts",
  "src/lib/mom-announcement.ts",
  "src/lib/mom.ts",
  "src/lib/payment-outcome.ts",
  "src/lib/pipeline/compose.ts",
  "src/lib/rating-progress-answer.ts",
  "src/lib/scheduler-copy.ts",
  "src/lib/stats-blast.ts",
  "src/lib/unresolved-nudge.ts",
];

describe("no long dash in the string tables", () => {
  it.each(TABLES)("%s", (file) => {
    expect(unexpected(longDashStrings(file))).toEqual([]);
  });

  it("the scan really reads the tables (it finds the one prompt-bound entry)", () => {
    const hits = longDashStrings("src/lib/i18n/strings.en.ts");
    expect(hits.map((h) => h.owner)).toEqual(["dm_fee_confirm_prompt"]);
  });
});

describe("no long dash on any page or component", () => {
  it("finds the pages", () => {
    expect(PAGES.length).toBeGreaterThan(100);
  });

  it("no .tsx under src/app or src/components carries one", () => {
    expect(PAGES.flatMap((f) => unexpected(longDashStrings(f)))).toEqual([]);
  });
});

describe("no long dash in the fixed wording outside the tables", () => {
  it.each(COPY_MODULES)("%s", (file) => {
    expect(unexpected(longDashStrings(file))).toEqual([]);
  });
});

describe("the prompt-bound list is exact", () => {
  it.each(PROMPT_BOUND)("$file $owner still carries its dash (remove it from the list when it goes)", (a) => {
    const hits = longDashStrings(a.file).filter((h) => h.owner === a.owner);
    expect(hits).toHaveLength(a.count);
    expect(a.why.length).toBeGreaterThan(20);
  });
});

describe("the scanner itself", () => {
  it("sees a dash written as a character, an escape and an entity, and skips comments and logs", () => {
    const sf = (code: string) => {
      const hits: string[] = [];
      const file = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node): void => {
        if ((ts.isStringLiteral(n) || ts.isJsxText(n)) && !isLogArgument(n)) {
          const value = (n as ts.StringLiteralLike).text ?? "";
          if (LONG_DASH.test(n.getText(file)) || LONG_DASH.test(value)) hits.push(n.getText(file).trim());
        }
        ts.forEachChild(n, visit);
      };
      visit(file);
      return hits;
    };
    expect(sf('const a = "x — y";')).toHaveLength(1);
    expect(sf('const a = "x \\u2013 y";')).toHaveLength(1);
    expect(sf("const a = <p>x &mdash; y</p>;")).toHaveLength(1);
    expect(sf('// x — y\nconst a = "x, y"; /* a – b */')).toHaveLength(0);
    expect(sf('console.error("x — y");')).toHaveLength(0);
  });
});

describe("no long dash survives the model-output pass", () => {
  // What a model actually writes, and the awkward shapes around it.
  const MODEL_OUTPUT = [
    "Squad update — need 3 more.\n\n*Playing tonight:*\n1. Kemal Ediz\n2. 🥁",
    "🗓 *Tuesday 7-a-side* — need *1 more* – kickoff 21:30 at Sim Arena.",
    "⚠️ THIS MATCH IS AT RISK — 8/14 — organiser decides.",
    "Reds won 5–3 — Kemal got Man of the Match — 4 votes.",
    "Pitch is booked 21:30–22:30 — bring bibs.",
    "Your stats — https://matchtime.ai/profile/stats?t=a–b — any time.",
    "Jean–Pierre is in — Anne–Marie is on the bench.",
    "Average rating: — (squad avg —)",
    "— Kemal\n— Elvin\n–",
    "*Kemal —* you're up —",
    "word—word—word",
    "—",
  ];

  it.each(["en", "tr"] as const)("%s: applyHouseStyle leaves none, outside a link", (lang) => {
    for (const text of MODEL_OUTPUT) {
      const out = applyHouseStyle(text, lang).replace(/https?:\/\/\S+/g, "");
      expect(hasLongDash(out), `${lang}: ${JSON.stringify(text)} gave ${JSON.stringify(out)}`).toBe(false);
    }
  });

  it.each(["en", "tr"] as const)("%s: stripLongDashes leaves none, outside a link", (lang) => {
    for (const text of MODEL_OUTPUT) {
      const out = stripLongDashes(text, lang).replace(/https?:\/\/\S+/g, "");
      expect(hasLongDash(out), `${lang}: ${JSON.stringify(text)}`).toBe(false);
    }
  });

  // Every place a model's words are handed on to a person calls the pass.
  // Listed by file so a new composer has to be added here on purpose.
  it.each([
    ["src/lib/message-analyzer.ts", /applyHouseStyle\(enforceProximity\(/],
    ["src/lib/dm-qa.ts", /if \(lang === "en"\) return applyHouseStyle\(text, lang\);/],
    ["src/lib/dm-qa.ts", /return applyHouseStyle\(cut \|\| text, lang\);/],
    ["src/lib/pipeline/stats-generic.ts", /stripLongDashes\(text, args\.lang\)/],
    ["src/lib/onboarding-analyzer.ts", /stripLongDashes\(po\.evidence/],
    ["src/lib/onboarding-analyzer.ts", /stripLongDashes\(ph\.evidence/],
    ["src/lib/rating-adjuster.ts", /stripLongDashes\(r\.reason/],
  ])("%s runs the pass on what the model wrote", (file, call) => {
    expect(readFileSync(path.join(ROOT, file), "utf8")).toMatch(call);
  });
});
