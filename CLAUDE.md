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
the suites made about **18,500**. They shared the production API key, so the real cost of running
MatchTime (about $4 per club per month) was invisible underneath our testing. (The keys are
separate now, see the note at the end of this section. The approval rule stands regardless:
a separate key makes the spend visible, it does not make it free.)

**When a run is approved:** smallest subset that exercises the change, `REPEAT=3` while iterating,
a full pass only as a final gate, and report the number of model calls made.

**Unit tests and the Playwright web suite make no model calls, cost nothing, and stay mandatory
on every change.** Do not confuse the two kinds of suite.

**When a run IS approved, it spends `ANTHROPIC_API_KEY_DEV`, not `ANTHROPIC_API_KEY`.** Every
harness in this repo resolves the dev key and refuses to run without it; it never falls back to
the production key, which is what Vercel sets and the only name anything under `src/` reads.
Put the dev key in the repo-root `.env`. See `MDs/dev-vs-production-api-keys.md`.

## RULE: rewrite a prompt when you change it, never append to it (Kemal, 2026-09-23)

**When a change needs a prompt to understand something new, rewrite that prompt as a whole. Do not bolt the new rule or examples onto the end.** Kemal: *"do not make the prompt bigger and huge by always adding to the end, no, redo the entire prompt and make it clearer and explain what is needed much better."*

**Why:** a prompt grown by patches ends up with each field explained in several places, rulings that contradict each other, and examples piled up at the bottom by date rather than grouped by meaning. That is part of why the model keeps discarding things (e.g. "ratings" and "top 10" on 2026-09-22, "the last 1 year" on 2026-09-23).

**How to apply:**
- One coherent explanation of the task; every field defined once, in one place, with when to leave it empty; each ruling stated once.
- Examples grouped by what they teach, deduplicated, English and Turkish side by side.
- Shorter if clarity allows, but clarity wins over length. Report before and after size, and keep it above the model's prompt-cache floor (`src/lib/pipeline/__tests__/cache-threshold.test.ts`).
- **A rewrite widens the regression risk, so the approved live check must cover every behaviour the prompt already handles, not just the new one.** Say so when asking Kemal to approve the run, and size the budget accordingly. Any case that passed before and fails after is a regression to fix before merging.
