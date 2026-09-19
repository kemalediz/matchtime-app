@AGENTS.md

## Use subagents for long-running work — do simple things yourself (Kemal's rule, 2026-06-12; refined 2026-06-18)

Use subagents (the Agent/Task tool) for **long-running or substantial work** — multi-step builds, deploys, broad/multi-file investigations, data migrations, anything that takes a while or burns a lot of context. Run those in the background where possible so the main thread stays free to talk with Kemal and dispatch more work.

**Do NOT spin up an agent for simple, quick things — do them yourself in the main thread.** A one-file lookup, a single grep, a quick command, reading a config value, a small edit, or a fact you can grab in seconds: just do it inline. An agent for those is slower and wasteful.

- The test: would an agent meaningfully save time or context (long task, lots of files, parallelism)? If yes → agent. If it's a quick lookup or small change → do it directly.
- **ALWAYS use `model: "opus"` for EVERY subagent. NEVER use `model: "fable"`** (Kemal's rule, 2026-07-26). No exceptions: features, edits, investigations, deploys, config, content, and the hard, complex, concurrency, or architecture tasks too. Fable is retired for Cressoft work. `model: "opus"` resolves to the current Opus tier (Claude Opus 5 today), so it stays correct as newer Opus releases land.
- **The main session REVIEWS everything a subagent delivers** before it is accepted, merged, shipped, or reported to Kemal as done: read the diff, re-run the gates (`tsc`, tests, build) yourself, spot-check load-bearing claims. See parent `Cressoft/CLAUDE.md`.

## RULE: live-LLM suites and dry runs need Kemal's approval, every time (Kemal, 2026-09-19)

**Never run `scripts/dryrun-pipeline.ts`, `npm run test:corpus`, `e2e/run.ts sim/`, or any other
suite that calls the real model, without asking Kemal first and getting a yes.** Both conditions
must hold: the change is a major one that touches the PROMPTS (router, extractor, composer,
classification, a new language), and Kemal approved that specific run in that conversation.

Schema changes, arithmetic, UI, copy, migrations, crons and refactors do NOT qualify, whatever
their size. The seven-slice club-scoped ratings rebuild needed zero live runs.

**Why:** September 2026 billed $184.60, and `MDs/llm-spend-september-2026.md` MEASURED that 98%
of it was our own harnesses, not the live bot. Production made **77** router calls all month;
the suites made about **18,500**. They share the production API key, so the real cost of running
MatchTime (about $4 per club per month) was invisible underneath our testing.

**When a run is approved:** smallest subset that exercises the change, `REPEAT=3` while iterating,
a full pass only as a final gate, and report the number of model calls made.

**Unit tests and the Playwright web suite make no model calls, cost nothing, and stay mandatory
on every change.** Do not confuse the two kinds of suite.
