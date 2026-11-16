/**
 * THE PURE RULES OF `scripts/set-match-result.ts` (2026-11-16, review of
 * #609): no database, no network, no process exit, so the unit tests
 * (`__tests__/set-match-result-rules.test.ts`) can pin them.
 */

/**
 * Who-is-who's whole budget. An API that takes the call and never answers
 * would otherwise hold the script for the SDK's 10 minutes per attempt,
 * times its retries, times who-is-who's own second attempt, saying nothing.
 */
export const WHO_IS_WHO_TIMEOUT_MS = 60_000;
/** The client's own retries, inside that budget. */
export const WHO_IS_WHO_CLIENT_MAX_RETRIES = 1;
/** Shortens the budget for the e2e test. An MT_TEST_ variable, so only ever
 *  honoured against the harness's own database (`stubsOnRealData`). */
export const WHO_IS_WHO_TIMEOUT_ENV = "MT_TEST_WHO_IS_WHO_TIMEOUT_MS";

type Env = Record<string, string | undefined>;

/** The overall budget in milliseconds: the default, or a positive override. */
export function whoIsWhoTimeoutMs(env: Env): number {
  const raw = (env[WHO_IS_WHO_TIMEOUT_ENV] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : WHO_IS_WHO_TIMEOUT_MS;
}

/** What the script hands the Anthropic client it builds for who-is-who. */
export function whoIsWhoClientOptions(apiKey: string, budgetMs: number): { apiKey: string; timeout: number; maxRetries: number } {
  return { apiKey, timeout: budgetMs, maxRetries: WHO_IS_WHO_CLIENT_MAX_RETRIES };
}

/**
 * The e2e suite's stand-ins (MT_TEST_* variables) answer for the model and
 * other services. Left in an operator's shell they would make the script
 * use them on real data. Returns what is on (empty: nothing to refuse):
 * every MT_TEST_ variable present with any value but exactly "" (" " is on:
 * the extractor stub reads any non-empty value as a file), and a stub
 * reader that says it is on (`readersOn`), unless the database is the
 * harness's own, compared EXACTLY.
 */
export function stubsOnRealData(a: { env: Env; readersOn: boolean; harnessDbUrl: string }): string[] {
  if (a.env.DATABASE_URL === a.harnessDbUrl) return [];
  const set = Object.keys(a.env)
    .filter((k) => k.startsWith("MT_TEST_") && a.env[k] !== undefined && a.env[k] !== "")
    .sort();
  if (set.length === 0 && a.readersOn) return ["a stub reader is on"];
  return set;
}

export interface Args {
  match: string | null;
  score: string | null;
  mom: string | null;
  by: string | null;
  apply: boolean;
}
const VALUED = ["match", "score", "mom", "by"] as const;

/**
 * THE ARGUMENTS, STRICTLY. A forgiving reader turned `--mom ""`,
 * `--mom=Pat` or a forgotten value into "no --mom", and the score was
 * written with no Man of the Match and no word said; `--by ""` became the
 * first owner. Every flag is known and given once; a valued flag has a
 * non-blank value after a space; --apply takes none.
 */
export function readArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  const out: Args = { match: null, score: null, mom: null, by: null, apply: false };
  const seen = new Set<string>();
  const no = (error: string) => ({ ok: false as const, error });
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) return no(`unexpected "${token}": every value goes after its flag (--mom <name>)`);
    const name = token.slice(2);
    const base = name.split("=")[0];
    const known = base === "apply" || (VALUED as readonly string[]).includes(base);
    if (!known) return no(`unknown flag "${token}" (known: --match, --score, --mom, --by, --apply)`);
    if (name !== base) return no(base === "apply" ? `"${token}": --apply takes no value (write --apply)` : `"${token}": write the value after a space (--${base} <value>)`);
    if (seen.has(name)) return no(`--${name} is given twice`);
    seen.add(name);
    if (name === "apply") {
      out.apply = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") return no(`--${name} needs a value`);
    out[name as (typeof VALUED)[number]] = value;
    i++;
  }
  return { ok: true, args: out };
}
