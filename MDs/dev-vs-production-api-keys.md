# Two Anthropic keys: one for the product, one for us

2026-09-19. Wiring only. No prompt, model pin or application behaviour
changed.

---

## The short version

| Variable | Who sets it | Who reads it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Vercel project env, and nothing else in normal use | Every model call site under `src/` |
| `ANTHROPIC_API_KEY_DEV` | Your local `.env`, and only there | Every harness, dry run and live sweep in this repo |

A harness that cannot find `ANTHROPIC_API_KEY_DEV` **stops with a
message naming the variable**. It does not fall back to
`ANTHROPIC_API_KEY`, ever.

To get going: create a second key in the Anthropic console, then add one
line to the repo-root `.env`.

```
ANTHROPIC_API_KEY_DEV="sk-ant-..."
```

That is the whole setup. Nothing else needs changing.

---

## Why

`MDs/llm-spend-september-2026.md` measured it. September billed $184.60.
The live bot serving Sutton FC made **77** router calls all month and
cost about $3.50. Our own harnesses made about **18,500** and cost the
other ~$181, because `e2e/run.ts` loaded the repo-root `.env` and every
sweep spent the production key out of it.

The money is not the problem: $181 of testing is a reasonable month. The
problem is that **the real cost of running MatchTime, about $4 per club
per month, was invisible** underneath it, and that is the number that
decides how club two and club three get priced. Section 6 item 1 of the
spend document asks for exactly this separation: it saves nothing
directly, and it turns "why is my bill $184" into two dashboard lines.

A silent fallback would undo all of it. If a missing dev key quietly
meant "use production", the two lines would re-merge the first time
somebody ran a sweep on a fresh checkout, and nothing would go red. So
there is no fallback path in the code at all, and
`e2e/helpers/no-production-key-in-harnesses.test.ts` scans the source on
every `npm run test:unit` to keep it that way.

---

## The seam

`src/` is the product and it is **untouched**. `pipeline/llm.ts`,
`message-analyzer.ts`, `dm-qa.ts`, `fee-confirm.ts` and the rest still
read `ANTHROPIC_API_KEY`, which is what Vercel sets. That matters
because several of those modules are imported by **both** the deployed
app and a harness, so the choice of key cannot live in them. Putting
`ANTHROPIC_API_KEY_DEV ?? ANTHROPIC_API_KEY` in a shared library file
would hand the dev key to production and re-merge the bills in the other
direction.

The choice lives in **the caller's environment** instead
(`e2e/helpers/dev-api-key.ts`):

- **In-process harnesses** (`scripts/dryrun-*.ts`,
  `scripts/measure-claimless.ts`, `scripts/chase-at-risk-live.ts`,
  `scripts/sim-onboarding.ts`, `e2e/replay/router-*-live.ts`) call
  `spendDevApiKey()` as the first statement of their entry function. It
  resolves `ANTHROPIC_API_KEY_DEV` and assigns it **over**
  `ANTHROPIC_API_KEY` for that process only. Library code then reads the
  one name it always read and gets the developer's key.

  It has to run before the first model call: some call sites cache their
  SDK client (`message-analyzer.ts` keeps a module-level `_anthropic`).

- **Child-process harnesses** (the whole e2e suite) resolve the key in
  `buildTestEnv()` and write it into the environment overlay handed to
  the Next server under test and the Playwright workers. `e2e/run.ts`
  additionally **deletes** the production key from its own process right
  after loading `.env`, because every child is spawned with
  `{ ...process.env, ...overlay }` and an inherited key is exactly how
  this started.

A stubbed e2e run needs no key of either kind: `buildTestEnv()` pins
`ANTHROPIC_API_KEY` empty and the run cannot call a model at all. Only
`MT_SIM_LIVE_LLM=1` requires the dev key.

---

## What happens when the dev key is missing

```
REFUSING to run. scripts/dryrun-pipeline.ts needs ANTHROPIC_API_KEY_DEV and it is not set.
  Development model calls go on the DEVELOPER's key. This harness never falls back
  to ANTHROPIC_API_KEY: a silent fall back is how ~18,500 harness calls ended up on
  the same bill as the 77 the live bot made in September, and it would hide the
  cost of running MatchTime all over again. See MDs/llm-spend-september-2026.md.
  Fix:  add a line to the repo-root .env
          ANTHROPIC_API_KEY_DEV="sk-ant-..."
        (create the key in the Anthropic console, separate from the production one)
  Then re-run.
```

The e2e orchestrator prints that and exits 1, the same way it treats a
port preflight refusal. The replay sweeps print it prefixed with their
tag and return 1. No model is called and nothing is billed.

---

## The Raspberry Pi is not affected

Checked: `whatsapp-bot/` has **no Anthropic dependency and never reads
`ANTHROPIC_API_KEY`**. Its only environment variables are
`MATCHTIME_API_URL`, `WHATSAPP_API_KEY`, `CHROMIUM_PATH`,
`SCHEDULER_INTERVAL_*`, `BOT_RECOVER_DM_REPLIES`, `MT_BOT_LOCK_PATH` and
`INVOCATION_ID`. It forwards messages over HTTP and the model call
happens server-side on Vercel, on the production key. **Nothing to
change on the Pi, and no redeploy needed for this.**

---

## Things that are NOT harnesses, and stay on production

- `scripts/sim-onboarding-remote.ts` POSTs to the **deployed** server at
  `MATCHTIME_API_URL`. The model call happens inside production, on
  production's key, by design. Running it is running the product, and
  its spend is production spend. That is correct, but worth knowing
  before you loop it.
- `scripts/compare-club-scoped-ratings.ts` and
  `scripts/compare-rating-formulas.ts` make **no model calls**. They read
  the database and run `balanceTeams` / `computeClubRating`, both pure.
  They need no key of either kind.

---

## The guard

`e2e/helpers/no-production-key-in-harnesses.test.ts` runs with the unit
suite and fails if:

1. anything orchestrator-side (`scripts/`, `e2e/run.ts`, `e2e/helpers`,
   `e2e/replay`, `e2e/corpus`) reads `process.env.ANTHROPIC_API_KEY`;
2. a harness constructs an SDK client without going through the
   resolver;
3. one of the named live harnesses stops calling the resolver, or is
   renamed or deleted without the list being updated;
4. anything under `src/` so much as mentions `ANTHROPIC_API_KEY_DEV`.

(4) is the one that matters most. It is the shared-module trap: the
tidy-looking fix for a missing dev key is a `??` in whichever library
file builds the client, and that single line would put production back
on the wrong key.

Playwright specs under `e2e/api`, `e2e/web` and `e2e/sim` are
deliberately not scanned. They run in workers whose environment came
from `buildTestEnv()`, so reading `ANTHROPIC_API_KEY` there is reading
the value this fix put in, not reaching past it.
