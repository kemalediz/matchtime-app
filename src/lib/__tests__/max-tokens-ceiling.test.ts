/**
 * RECURRENCE GUARD — do not delete.
 *
 * This has now bitten three times:
 *   2026-05-26  analyzeBatch was set to the model max → the WHOLE analyzer
 *               was dead for ~30 minutes before anyone noticed.
 *   2026-08-31  composeChaseText (max_tokens: 64000) → every scheduled
 *               chase had ALWAYS silently used the static fallback text.
 *   2026-08-31  the dropped-verdict re-prompt (max_tokens: 64000) → the
 *               recovery path had NEVER run; placeholders survived and
 *               admin DMs fired instead.
 *
 * WHY IT KEEPS HAPPENING: 64000 looks correct — it IS Sonnet 4.5's real
 * output ceiling — and the failure is invisible. The Anthropic SDK
 * refuses the request locally, BEFORE any network call, so there is no
 * API error, no 4xx, no latency, nothing in any dashboard. Every one of
 * these call sites sits inside a try/catch with a fallback, so the only
 * symptom is degraded output that looks like a bad model day.
 *
 * THE RULE (node_modules/@anthropic-ai/sdk/src/client.ts,
 * `_calculateNonstreamingTimeout`) — for every NON-streaming request:
 *
 *     expectedTimeout = 60 * 60 * max_tokens / 128_000     // seconds
 *     if (expectedTimeout > 600) throw AnthropicError(
 *       "Streaming is required for operations that may take longer
 *        than 10 minutes.")
 *
 * Solving for the limit: max_tokens must be <= 600 * 128_000 / 3_600
 * = 21_333. We hold a stricter project ceiling below that, with margin.
 *
 * A comment did not prevent recurrence twice over, so this test reads
 * the SOURCE of every file under src/ and fails the build on a bad
 * value — including in a call site that does not exist yet.
 *
 * If this test fails: LOWER the number. Do NOT raise the ceiling and do
 * NOT switch the call to streaming to "fix" it — none of these calls
 * need minutes of runtime; the number was simply set wrong.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** Derived from the SDK formula above — the hard limit it enforces. */
const SDK_NONSTREAMING_LIMIT = Math.floor((600 * 128_000) / 3_600); // 21_333

/**
 * Our project ceiling. Deliberately below the SDK limit so a call site
 * has headroom rather than sitting on the cliff edge, and high enough
 * that no realistic batch is ever truncated.
 */
const PROJECT_CEILING = 16_384;

const SRC = path.resolve(__dirname, "../..");
const ANALYZER = path.join(SRC, "lib", "message-analyzer.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `const NAME = <rhs>;` across all of src, keeping the RHS as source
 * text so identifier→identifier aliases (`const A = B;`) resolve
 * transitively.
 */
function constantDecls(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const re =
      /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([^;\n]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      map.set(m[1], m[2].trim());
    }
  }
  return map;
}

type Site = { file: string; line: number; expr: string };

/** Every `max_tokens: <expr>` in the file, with its value expression. */
function maxTokensSites(file: string): Site[] {
  const sites: Site[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = /(?:^|[\s{,(])max_tokens\s*:\s*(.+?)\s*,?\s*(?:\/\/.*)?$/.exec(line);
    if (!m) return;
    // Skip comment lines — `// max_tokens: 16384 — ...` is prose.
    if (/^\s*(\/\/|\*)/.test(line)) return;
    sites.push({ file, line: i + 1, expr: m[1].trim() });
  });
  return sites;
}

/**
 * Resolve a `max_tokens` value expression to a provable upper bound.
 * Returns `null` when the expression is not statically boundable —
 * which is itself a failure, because an unbounded expression can drift
 * past the SDK limit at runtime with no warning.
 */
function upperBound(
  expr: string,
  consts: Map<string, string>,
  seen: Set<string> = new Set(),
): number | null {
  const e = expr.trim().replace(/,$/, "");

  // 1. Numeric literal: `16384`, `16_384`
  if (/^[\d_]+$/.test(e)) return Number(e.replace(/_/g, ""));

  // 2. Identifier — resolve through alias chains (`const A = B = 16384`).
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (seen.has(e)) return null; // cycle
    const rhs = consts.get(e);
    if (rhs === undefined) return null;
    return upperBound(rhs, consts, new Set([...seen, e]));
  }

  // 3. Clamped expression: `Math.min(CEILING, 200 + 80 * n)` — the bound
  //    is the first argument, whatever the second argument does.
  const clamp = /^Math\.min\s*\(\s*([^,]+?)\s*,/.exec(e);
  if (clamp) return upperBound(clamp[1], consts, seen);

  return null;
}

/**
 * COMPANION GUARD — truncation.
 *
 * Fixing the ceiling created a failure mode that could not previously
 * happen: with a sane cap the model can actually REACH it, and then
 * `stop_reason === "max_tokens"` means the text is a sentence cut off
 * mid-word. At 64000 the call always threw, so this was unreachable.
 *
 * Most call sites are protected for free: they JSON.parse the output,
 * and truncated JSON never parses, so they fail closed into an existing
 * fallback. Sites that hand the model's RAW TEXT to a human have no
 * such protection — a truncated chase gets posted to a customer's
 * WhatsApp group, a truncated DM answer gets sent to a player.
 *
 * Rather than demand a `stop_reason` check everywhere (9 of 11 sites do
 * not need one, so that would be mostly false positives), every file
 * with a `messages.create` must EITHER check `stop_reason` OR be listed
 * below with the reason its truncation already fails closed. A new call
 * site forces a deliberate choice instead of a default of "nothing".
 *
 * Known limitation: this is file-level, not call-level. `message-analyzer.ts`
 * has three call sites (two JSON, one free text) and passes because the
 * free-text one is guarded. That is the intended trade — a call-level
 * check needs real dataflow analysis, and a guard people learn to
 * silence is worse than one they trust.
 */
const TRUNCATION_FAILS_CLOSED: Record<string, string> = {
  "lib/squad-from-list.ts":
    "JSON.parse of a truncated body throws → caught → returns [] → no DB writes.",
  "lib/onboarding-analyzer.ts":
    "normaliseAnalysis JSON.parses twice, both fail on truncation → returns null.",
  "lib/onboarding-conversation.ts":
    "JSON.parse throws → falls back to regexExtract, which is the designed fallback.",
  "lib/rating-adjuster.ts":
    "normaliseAdjustments JSON.parse fails → empty map → no rating changes applied.",
  "lib/match-availability-classifier.ts":
    "parse() fails → UNCLEAR verdict, which is the safe default.",
  "lib/roster-survey-classifier.ts": "parse() fails → the caller's fallback classification.",
  "lib/window-analyzer.ts":
    "Shadow analysis only — off by default (#28), telemetry, never user-facing.",
};

describe("truncation coverage (companion guard)", () => {
  const files = walk(SRC);
  const callSites = files.filter((f) =>
    /\bmessages\s*\.\s*create\s*\(/.test(fs.readFileSync(f, "utf8")),
  );

  it("finds the known messages.create files (the scanner still works)", () => {
    expect(callSites.length).toBeGreaterThanOrEqual(9);
  });

  it("has no stale exemptions", () => {
    const live = new Set(callSites.map((f) => path.relative(SRC, f)));
    const stale = Object.keys(TRUNCATION_FAILS_CLOSED).filter((f) => !live.has(f));
    expect(
      stale,
      `These files are exempted from the truncation check but no longer ` +
        `contain a messages.create call. Remove them from ` +
        `TRUNCATION_FAILS_CLOSED so the list cannot rot into a rubber stamp.`,
    ).toEqual([]);
  });

  it("every messages.create file checks stop_reason or is a documented fail-closed site", () => {
    const unguarded = callSites
      .map((f) => path.relative(SRC, f))
      .filter((rel) => !(rel in TRUNCATION_FAILS_CLOSED))
      .filter(
        (rel) => !/stop_reason/.test(fs.readFileSync(path.join(SRC, rel), "utf8")),
      );

    expect(
      unguarded,
      unguarded.length === 0
        ? ""
        : `\n\n${unguarded.length} file(s) call messages.create without handling ` +
            `truncation:\n\n${unguarded.map((f) => `  • src/${f}`).join("\n")}\n\n` +
            `WHY THIS MATTERS\n` +
            `  When the model hits max_tokens the response comes back with\n` +
            `  stop_reason === "max_tokens" and the text is cut off mid-word.\n` +
            `  There is no error and no exception — it looks like a normal\n` +
            `  reply. Posting it sends half a sentence to a real user.\n\n` +
            `PICK ONE\n` +
            `  (a) The output is shown to a human / used as free text:\n` +
            `      check \`if (resp.stop_reason === "max_tokens")\`, log loudly,\n` +
            `      and return your existing fallback. Partial text is always\n` +
            `      worse than the fallback.\n` +
            `  (b) The output is JSON-parsed, so truncation already fails\n` +
            `      closed: add the file to TRUNCATION_FAILS_CLOSED in this\n` +
            `      test with a one-line reason naming the fallback it hits.\n`,
    ).toEqual([]);
  });
});

describe("max_tokens ceiling (recurrence guard)", () => {
  const files = walk(SRC);

  it("declares the shared ceiling in message-analyzer.ts", () => {
    const src = fs.readFileSync(ANALYZER, "utf8");
    const m = /export const MAX_TOKENS_CEILING\s*=\s*([\d_]+)\s*;/.exec(src);
    expect(
      m,
      "MAX_TOKENS_CEILING must stay declared and exported from " +
        "src/lib/message-analyzer.ts — it is the single source of truth " +
        "every messages.create call site derives its cap from. Deleting " +
        "it disables this guard.",
    ).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBe(PROJECT_CEILING);
  });

  it("keeps the project ceiling below the SDK's non-streaming limit", () => {
    expect(
      PROJECT_CEILING,
      `The Anthropic SDK throws "Streaming is required for operations ` +
        `that may take longer than 10 minutes" for any non-streaming ` +
        `max_tokens above ${SDK_NONSTREAMING_LIMIT}.`,
    ).toBeLessThanOrEqual(SDK_NONSTREAMING_LIMIT);
  });

  it("finds the known call sites (the scanner itself still works)", () => {
    const sites = files.flatMap(maxTokensSites);
    // If this drops to ~0 the regex has rotted and the guard below is
    // vacuously passing — which is exactly how a guard stops guarding.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(sites.some((s) => s.file === ANALYZER)).toBe(true);
  });

  it("no messages.create call site in src/ exceeds the ceiling", () => {
    const consts = constantDecls(files);
    const bad: string[] = [];

    for (const site of files.flatMap(maxTokensSites)) {
      const rel = path.relative(SRC, site.file);
      const bound = upperBound(site.expr, consts);

      if (bound === null) {
        bad.push(
          `src/${rel}:${site.line} — max_tokens: ${site.expr}\n` +
            `      Not statically boundable. Clamp it, e.g. ` +
            `Math.min(MAX_TOKENS_CEILING, <your expression>).`,
        );
      } else if (bound > PROJECT_CEILING) {
        bad.push(
          `src/${rel}:${site.line} — max_tokens: ${site.expr} (= ${bound})\n` +
            `      Exceeds the project ceiling of ${PROJECT_CEILING}.`,
        );
      }
    }

    expect(
      bad,
      bad.length === 0
        ? ""
        : `\n\n${bad.length} max_tokens value(s) above the safe ceiling:\n\n` +
            `${bad.map((b) => `  • ${b}`).join("\n")}\n\n` +
            `WHY THIS FAILS THE BUILD\n` +
            `  The Anthropic SDK refuses a NON-STREAMING request whose\n` +
            `  implied runtime exceeds 10 minutes, and it does so LOCALLY,\n` +
            `  before any network call:\n\n` +
            `      expectedTimeout = 60 * 60 * max_tokens / 128000   (seconds)\n` +
            `      if (expectedTimeout > 600) throw AnthropicError(\n` +
            `        "Streaming is required for operations that may take\n` +
            `         longer than 10 minutes.")\n\n` +
            `  So the SDK's hard limit is max_tokens <= ${SDK_NONSTREAMING_LIMIT},\n` +
            `  and we hold a stricter ceiling of ${PROJECT_CEILING}.\n\n` +
            `  Every one of these call sites is wrapped in try/catch with a\n` +
            `  fallback, so a bad value does NOT surface as an error — it\n` +
            `  silently degrades output forever. This has happened three\n` +
            `  times (2026-05-26 analyzeBatch; 2026-08-31 composeChaseText\n` +
            `  and the dropped-verdict re-prompt).\n\n` +
            `HOW TO FIX\n` +
            `  Lower the number, ideally to MAX_TOKENS_CEILING or a smaller\n` +
            `  per-call constant derived from it. Do NOT raise the ceiling.\n` +
            `  Do NOT convert the call to streaming to get around this —\n` +
            `  none of these calls need minutes of runtime.\n`,
    ).toEqual([]);
  });
});
