/**
 * ══════════════════════════════════════════════════════════════════════
 * NOTHING CALLS SONNET 4.5 ANY MORE, AND EVERY SONNET 5 CALL SAYS
 * WHETHER IT MAY THINK.
 * ══════════════════════════════════════════════════════════════════════
 *
 * `MDs/llm-spend-september-2026.md` §4 established that every surviving
 * `claude-sonnet-4-5` pin was INHERITED from `analyzeBatch`, which was
 * deleted on 2026-09-06 (`8dc64fb`). Not one of them was chosen. Sonnet
 * 5 is newer, has a 1M context window and costs $2/$10 per MTok against
 * Sonnet 4.5's $3/$15, so there was no argument for keeping 4.5
 * anywhere. Kemal, 2026-09-19: "Remove the fossil."
 *
 * A grep does not stay done, so this file is the guard. It has two
 * halves because the move has two halves.
 *
 * ── HALF ONE: no model pin names 4.5 ─────────────────────────────────
 *
 * The scan reads SOURCE under `src/`, `scripts/` and `e2e/` and fails on
 * any line that puts `claude-sonnet-4-5` in a MODEL position: a
 * `model:` property, a `const MODEL = …`, a probe-list entry. Price and
 * threshold tables are explicitly allowed and explicitly tested for
 * below, because they are lookups, not pins: `pipeline/llm.ts`'s
 * `RATES` and `MIN_CACHEABLE_TOKENS` and `e2e/replay/meter.ts`'s
 * `PRICES` are how a historical ledger row or an old sweep is still
 * priced correctly, and deleting a rate is how a cost report silently
 * starts reporting null.
 *
 * ── HALF TWO: Sonnet 5 runs adaptive thinking unless told not to ──────
 *
 * This is the part that could have been a live incident rather than a
 * refactor. `src/lib/pipeline/llm.ts`'s `ModelRequest.thinking` records
 * the measurement (§10 step 8, 2026-09-06, 5 runs of 5): with the
 * `thinking` parameter OMITTED, `claude-sonnet-5` can spend the entire
 * `max_tokens` budget deliberating and return `stop_reason: max_tokens`
 * with thinking blocks and NO text block at all. Probed at 1,024, 2,048
 * and 4,096 tokens, zero text every time.
 *
 * Sonnet 4.5 does not do that: it thinks only when asked, with
 * `{type: "enabled", budget_tokens: N}`. So a pin moved from 4.5 to 5
 * without a `thinking` parameter is not the same call with a cheaper
 * price tag, it is a call that can now come back empty. Every one of
 * these sites has a tight cap sized for its OUTPUT and a fail-closed
 * path, so the symptom would have been silent degradation: the
 * scheduled chase falling back to static copy, a DM answered with the
 * generic apology, a rating adjuster returning no adjustments.
 *
 * So the rule is: any `messages.create` whose model resolves to
 * `claude-sonnet-5` MUST pass `thinking` explicitly. The test does not
 * insist on `"disabled"` at the call site, because a future site may
 * legitimately want adaptive thinking with a budget to match. It
 * insists that the decision is VISIBLE.
 *
 * A call site whose model this scan cannot resolve is a failure, not a
 * skip, unless it is named in `UNRESOLVED_BY_DESIGN`. "The scan could
 * not tell" is how a guard quietly stops guarding.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../..");
const ROOTS = ["src", "scripts", "e2e"].map((d) => path.join(REPO, d));

const RETIRED = "claude-sonnet-4-5";
const SONNET_5 = "claude-sonnet-5";

/**
 * The one call site that takes its model from its caller. It is the
 * pipeline's injectable seam: `complete(req)` sends `req.model`, and
 * which models reach it is pinned by `ROUTER_MODEL` / `EXTRACTOR_MODEL`
 * and by `__tests__/thinking-off.test.ts`, which asserts the extractors
 * ask for `thinking: "off"` and the router does not.
 */
const UNRESOLVED_BY_DESIGN = new Set(["src/lib/pipeline/llm.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
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

const FILES = ROOTS.flatMap((r) => walk(r));
const rel = (f: string) => path.relative(REPO, f);

/** A price or threshold table entry: `"claude-sonnet-4-5": { … }` or
 *  `"claude-sonnet-4-5": 1_024,`. Keyed BY the model, not pinned TO it. */
function isLookupTableEntry(line: string): boolean {
  return new RegExp(`^\\s*"${RETIRED}"\\s*:`).test(line);
}

/** Prose: a comment line, or a Markdown-ish narrative line inside one. */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

describe("no code pins claude-sonnet-4-5", () => {
  it("names it in no model position anywhere under src, scripts or e2e", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!line.includes(RETIRED)) return;
          if (isComment(line)) return;
          if (isLookupTableEntry(line)) return;
          offenders.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(
      offenders,
      `claude-sonnet-4-5 is superseded by claude-sonnet-5, which is newer and a third ` +
        `cheaper ($2/$10 against $3/$15). Every 4.5 pin in this repo was inherited from ` +
        `the deleted analyzeBatch, not chosen. If a site genuinely needs 4.5, say why ` +
        `here rather than letting the pin sit:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps its PRICE, because a retired model still has to be costable", () => {
    // Deleting the rate is how `costOf` starts returning null for a
    // ledger row or a replayed sweep, which reads as "free" rather than
    // as "unknown". The entries are lookups keyed by model id; nothing
    // sends them anywhere.
    const llm = fs.readFileSync(path.join(REPO, "src/lib/pipeline/llm.ts"), "utf8");
    expect(llm).toContain(`"${RETIRED}": { input: 3.0, output: 15.0 }`);
    expect(llm).toContain(`"${RETIRED}": 1_024`);
    const meter = fs.readFileSync(path.join(REPO, "e2e/replay/meter.ts"), "utf8");
    expect(meter).toContain(`"${RETIRED}": { input: 3, output: 15 }`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Every Sonnet 5 call site states its thinking posture
// ─────────────────────────────────────────────────────────────────────

interface CallSite {
  file: string;
  line: number;
  /** The request-object source, braces balanced. */
  body: string;
  /** The `model:` expression, resolved through file-local constants. */
  model: string | null;
}

/** `const NAME = "literal";` within one file. */
function stringConsts(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*"([^"]+)";/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) map.set(m[1], m[2]);
  return map;
}

/** From the `{` after `messages.create(`, read to its matching `}`. */
function balancedObject(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

function callSites(file: string): CallSite[] {
  const src = fs.readFileSync(file, "utf8");
  const consts = stringConsts(src);
  const out: CallSite[] = [];
  const re = /messages\.create\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = balancedObject(src, m.index);
    const line = src.slice(0, m.index).split("\n").length;
    const mm = /(?:^|[\s{,])model\s*:\s*([^,\n]+)/.exec(body);
    let model: string | null = null;
    if (mm) {
      const expr = mm[1].trim().replace(/,$/, "");
      const literal = /^"([^"]+)"$/.exec(expr);
      model = literal ? literal[1] : (consts.get(expr) ?? null);
    }
    out.push({ file, line, body, model });
  }
  return out;
}

const SITES = FILES.flatMap((f) => callSites(f));

describe("every messages.create site is legible to the guard", () => {
  it("finds the call sites at all", () => {
    // A rename of the SDK method would make every assertion below pass
    // vacuously. Twelve sites as of 2026-09-19.
    expect(SITES.length).toBeGreaterThanOrEqual(10);
  });

  it("resolves the model of every site except the injectable pipeline seam", () => {
    const unresolved = SITES.filter((s) => s.model === null).map(
      (s) => `${rel(s.file)}:${s.line}`,
    );
    const unexpected = unresolved.filter(
      (u) => !UNRESOLVED_BY_DESIGN.has(u.split(":")[0]),
    );
    expect(
      unexpected,
      `these call sites name a model this guard cannot resolve, so it cannot tell ` +
        `whether they need a thinking parameter. Pin the model to a string literal or ` +
        `a file-local const, or add the file to UNRESOLVED_BY_DESIGN with a reason:\n` +
        unexpected.join("\n"),
    ).toEqual([]);
  });
});

describe("claude-sonnet-5 never runs adaptive thinking by accident", () => {
  it("every Sonnet 5 call site passes thinking explicitly", () => {
    const sonnetSites = SITES.filter((s) => s.model === SONNET_5);
    expect(sonnetSites.length).toBeGreaterThan(0);
    const silent = sonnetSites
      .filter((s) => !/\bthinking\s*:/.test(s.body))
      .map((s) => `${rel(s.file)}:${s.line}`);
    expect(
      silent,
      `claude-sonnet-5 runs ADAPTIVE THINKING when the thinking parameter is omitted, ` +
        `and it can spend the whole max_tokens budget deliberating and return no text ` +
        `block at all (measured 2026-09-06, 5 runs of 5, at 1024/2048/4096 tokens; see ` +
        `ModelRequest.thinking in src/lib/pipeline/llm.ts). Sonnet 4.5 never did that, ` +
        `so a pin moved from 4.5 to 5 without a thinking parameter is a behaviour ` +
        `change, not a price change. Send thinking: { type: "disabled" }, or budget for ` +
        `thinking tokens deliberately:\n${silent.join("\n")}`,
    ).toEqual([]);
  });

  it("the five migrated sites turn it off, because none of them was ever asked to reason", () => {
    // Each of these has a max_tokens sized for its OUTPUT and a
    // fail-closed path. Disabling thinking is what keeps the move a
    // price change: on Sonnet 4.5 these calls never thought either.
    for (const f of [
      "src/lib/message-analyzer.ts",
      "src/lib/dm-qa.ts",
      "src/lib/rating-adjuster.ts",
      "src/lib/squad-from-list.ts",
      "src/lib/onboarding-analyzer.ts",
    ]) {
      const sites = callSites(path.join(REPO, f)).filter((s) => s.model === SONNET_5);
      expect(sites.length, `${f} has no claude-sonnet-5 call site`).toBeGreaterThan(0);
      for (const s of sites) {
        expect(
          /thinking\s*:\s*\{\s*type\s*:\s*"disabled"\s*\}/.test(s.body),
          `${f}:${s.line} is on claude-sonnet-5 without thinking: { type: "disabled" }`,
        ).toBe(true);
      }
    }
  });

  it("leaves the Haiku sites alone: they have a different thinking contract", () => {
    // `ModelRequest.thinking` is opt-in per model for this reason. The
    // router and the four DM-surface classifiers run claude-haiku-4-5,
    // which does not think unless handed `budget_tokens`, and nothing
    // here needs to send it a parameter it may not take.
    const haiku = SITES.filter((s) => s.model === "claude-haiku-4-5");
    expect(haiku.length).toBeGreaterThan(0);
    for (const s of haiku) {
      expect(
        /\bthinking\s*:/.test(s.body),
        `${rel(s.file)}:${s.line} sends a thinking parameter to claude-haiku-4-5`,
      ).toBe(false);
    }
  });
});
