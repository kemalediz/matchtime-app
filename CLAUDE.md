@AGENTS.md

## Use subagents for long-running work — do simple things yourself (Kemal's rule, 2026-06-12; refined 2026-06-18)

Use subagents (the Agent/Task tool) for **long-running or substantial work** — multi-step builds, deploys, broad/multi-file investigations, data migrations, anything that takes a while or burns a lot of context. Run those in the background where possible so the main thread stays free to talk with Kemal and dispatch more work.

**Do NOT spin up an agent for simple, quick things — do them yourself in the main thread.** A one-file lookup, a single grep, a quick command, reading a config value, a small edit, or a fact you can grab in seconds: just do it inline. An agent for those is slower and wasteful.

- The test: would an agent meaningfully save time or context (long task, lots of files, parallelism)? If yes → agent. If it's a quick lookup or small change → do it directly.
- **ALWAYS use `model: "opus"` for EVERY subagent. NEVER use `model: "fable"`** (Kemal's rule, 2026-07-26). No exceptions: features, edits, investigations, deploys, config, content, and the hard, complex, concurrency, or architecture tasks too. Fable is retired for Cressoft work. `model: "opus"` resolves to the current Opus tier (Claude Opus 5 today), so it stays correct as newer Opus releases land.
- **The main session REVIEWS everything a subagent delivers** before it is accepted, merged, shipped, or reported to Kemal as done: read the diff, re-run the gates (`tsc`, tests, build) yourself, spot-check load-bearing claims. See parent `Cressoft/CLAUDE.md`.
