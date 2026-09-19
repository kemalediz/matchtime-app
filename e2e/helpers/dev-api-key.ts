/**
 * ONE KEY FOR THE PRODUCT, ANOTHER FOR US.
 *
 * ── the measurement ──────────────────────────────────────────────────
 * September 2026 billed $184.60. `MDs/llm-spend-september-2026.md`
 * measured where it went: the live bot serving Sutton FC made **77**
 * router calls all month and cost about $3.50. Our own harnesses made
 * about **18,500** and cost the other ~$181. They shared one
 * `ANTHROPIC_API_KEY`, read out of the repo-root `.env`, so the real
 * price of running MatchTime (about $4 per club per month, the number
 * that actually matters for onboarding club two and club three) was
 * invisible underneath our testing. Section 6 item 1 of that document
 * asks for exactly this fix: not because it saves a dollar, but because
 * it turns "why is my bill $184" into two dashboard lines.
 *
 * ── the seam ─────────────────────────────────────────────────────────
 * `src/` is the product. Nothing in it changes and nothing in it knows
 * this file exists: `pipeline/llm.ts`, `message-analyzer.ts`, `dm-qa.ts`
 * and the rest keep reading `ANTHROPIC_API_KEY`, which is what Vercel
 * sets. (The Pi bot never reads it: no Anthropic dependency, it forwards
 * over HTTP.) Several of those modules are imported by BOTH the deployed
 * app and a harness, so the choice of key cannot live in them.
 *
 * It lives in the CALLER's environment instead. A harness resolves
 * `ANTHROPIC_API_KEY_DEV` and assigns it over `ANTHROPIC_API_KEY`
 * *inside its own process* (`spendDevApiKey`), or writes it into the
 * environment overlay it hands a child (`requireDevApiKey`, which is
 * what `buildTestEnv()` does for the server under test). The library
 * then reads the one name it always read and gets the developer's key,
 * with no branch in shared code for anyone to "tidy up" later.
 *
 * `spendDevApiKey` must therefore run BEFORE the first model call. Most
 * of the call sites build their SDK client lazily and cache it
 * (`message-analyzer.ts` keeps a module-level `_anthropic`), so "first
 * line of `main()`" is the rule, not "somewhere before the sweep".
 *
 * ── the one rule ─────────────────────────────────────────────────────
 * A missing dev key is a REFUSAL, never a fall back to
 * `ANTHROPIC_API_KEY`. A fall back would put development spend straight
 * back on the production key, which is the exact failure being fixed,
 * and it would do it silently. The harness would run, pass, and cost
 * money on the wrong line. This module has no fallback path at all;
 * `e2e/helpers/no-production-key-in-harnesses.test.ts` scans the source
 * to keep it that way.
 */

/**
 * What these functions read and write. A plain string map, not
 * `NodeJS.ProcessEnv`: Next augments that type with a required
 * `NODE_ENV`, which would force every caller and every test fixture to
 * carry a field none of this cares about. `process.env` satisfies it.
 */
export type MutableEnv = Record<string, string | undefined>;

/** The developer's key. Set it in the repo-root `.env`. */
export const DEV_KEY_ENV = "ANTHROPIC_API_KEY_DEV";

/** The product's key: Vercel, and every reader under `src/`. */
export const PROD_KEY_ENV = "ANTHROPIC_API_KEY";

/** Where the reasoning lives, quoted in the refusal so the developer who
 *  hits it can read the argument rather than guess at it. */
export const SPEND_DOC = "MDs/llm-spend-september-2026.md";

/** A refusal, not a crash. `e2e/run.ts` prints the message and nothing
 *  else, the same way it treats a preflight refusal. */
export class DevApiKeyMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevApiKeyMissingError";
  }
}

/** The dev key if it is usable, otherwise null. Blank and whitespace
 *  count as absent: `dotenv` leaves an empty assignment in `.env` as an
 *  empty string, and an empty string reaches the API as no key at all. */
export function readDevApiKey(env: MutableEnv = process.env): string | null {
  const value = (env[DEV_KEY_ENV] ?? "").trim();
  return value === "" ? null : value;
}

/**
 * The dev key, or a refusal naming the harness that wanted it.
 *
 * Use this when the key is going somewhere other than this process's own
 * environment: into a child's env overlay, or into an SDK client the
 * harness constructs itself.
 */
export function requireDevApiKey(harness: string, env: MutableEnv = process.env): string {
  const key = readDevApiKey(env);
  if (key) return key;
  throw new DevApiKeyMissingError(
    `REFUSING to run. ${harness} needs ${DEV_KEY_ENV} and it is not set.\n` +
      `  Development model calls go on the DEVELOPER's key. This harness never falls back\n` +
      `  to ${PROD_KEY_ENV}: a silent fall back is how ~18,500 harness calls ended up on\n` +
      `  the same bill as the 77 the live bot made in September, and it would hide the\n` +
      `  cost of running MatchTime all over again. See ${SPEND_DOC}.\n` +
      `  Fix:  add a line to the repo-root .env\n` +
      `          ${DEV_KEY_ENV}="sk-ant-..."\n` +
      `        (create the key in the Anthropic console, separate from the production one)\n` +
      `  Then re-run. Scripts started with \`node --env-file=.env\` pick it up; so does\n` +
      `  anything that calls dotenv's \`config()\`.`,
  );
}

/**
 * Resolve the dev key and make it THE key for this process.
 *
 * Named `spend...` rather than `use...` on purpose, twice over: it says
 * that money is about to be spent and on whose key, and `useX` inside a
 * plain function trips `react-hooks/rules-of-hooks` in this repo's
 * eslint config. Do not rename it back.
 *
 * This is the seam for every in-process harness: after this call,
 * library code under `src/` that reads `PROD_KEY_ENV` gets the
 * developer's key, and the production key that `.env` may have loaded
 * is gone from this process entirely. Returns the key for callers that
 * also want to hand it to an SDK client directly.
 *
 * Refuses before mutating anything, so a failed call leaves the
 * environment exactly as it found it.
 */
export function spendDevApiKey(harness: string, env: MutableEnv = process.env): string {
  const key = requireDevApiKey(harness, env);
  env[PROD_KEY_ENV] = key;
  return key;
}

/**
 * `spendDevApiKey`, for a standalone script: print the refusal and exit 1.
 *
 * The message is written to be read on its own. A stack trace under it
 * says only that a script called a function, which nobody needs, so the
 * scripts take this door and `e2e/run.ts` does the same thing through
 * its own top-level handler.
 */
export function spendDevApiKeyOrExit(harness: string, env: MutableEnv = process.env): string {
  try {
    return spendDevApiKey(harness, env);
  } catch (err) {
    if (err instanceof DevApiKeyMissingError) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Drop the production key from this process.
 *
 * For a harness that is NOT going to call a model but is going to spawn
 * children with `{ ...process.env, ... }`, i.e. the stubbed e2e run. Loading
 * `.env` put the production key in scope; nothing downstream should be
 * able to inherit it by accident.
 */
export function forgetProductionApiKey(env: MutableEnv = process.env): void {
  delete env[PROD_KEY_ENV];
}
