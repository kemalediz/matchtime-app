/**
 * CLUB SCENARIOS: every club shape MatchTime runs, played through the real
 * server with a moving clock, and written down as a normalised transcript
 * per club, so two branches can be compared step by step.
 *
 *   npm run scenarios:record    live model on ANTHROPIC_API_KEY_DEV, every call kept
 *   npm run scenarios:replay    no network, answers from the cassettes
 *   npm run scenarios:dry       stubbed model, free, for writing scenarios
 *
 * Optional: MT_SCENARIO_CLUBS=sutton,fnf (default: every file in clubs/);
 * MT_SCENARIO_OUT=dir (default .e2e/scenarios-out/<mode>).
 *
 * Each club starts from an EMPTY database (every table truncated, the
 * fixture world too), so nothing another club or the seed did is in its
 * picture, and nothing of it is in the next club's. The Pi is emulated by
 * the rehearsal driver: no WhatsApp anywhere.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";
import { clearPipelineStubs } from "../helpers/stub";
import { planTimeline } from "../rehearsal/clock";
import { RehearsalDriver } from "../rehearsal/driver";
import { ratePage } from "../rehearsal/rate-page";
import { parseScenario } from "../rehearsal/scenario";
import { renderMarkdown } from "../rehearsal/transcript";
import { cassetteMode } from "./mode";
import { buildTranscript } from "./normalise";

const CLUBS_DIR = path.join(__dirname, "clubs");
const mode = cassetteMode() ?? (process.env.MT_SCENARIOS_DRY === "1" ? "dry" : null);
test.skip(!mode, "club scenarios: run through npm run scenarios:record | scenarios:replay | scenarios:dry");

const wanted = (process.env.MT_SCENARIO_CLUBS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const clubs = readdirSync(CLUBS_DIR)
  .filter((f) => f.endsWith(".scenario.json"))
  .map((f) => f.replace(/\.scenario\.json$/, ""))
  .filter((c) => !wanted.length || wanted.includes(c))
  .sort();

const meterUrl = () => (process.env.MT_E2E_LIVE_METER_PORT ? `http://127.0.0.1:${process.env.MT_E2E_LIVE_METER_PORT}` : null);
async function cassette(p: string, body: unknown = {}): Promise<Record<string, unknown> | null> {
  const url = meterUrl();
  if (!url || mode === "dry") return null;
  const res = await fetch(`${url}${p}`, { method: "POST", body: JSON.stringify(body), headers: { connection: "close" } });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`cassette ${p}: ${String(json.error ?? res.status)}`);
  return json;
}

for (const club of clubs) {
  test(`club scenario: ${club}`, async ({ request, db, browser }) => {
    test.setTimeout(4 * 60 * 60 * 1000);
    const file = path.join(CLUBS_DIR, `${club}.scenario.json`);
    const scenario = parseScenario(JSON.parse(readFileSync(file, "utf8")));
    const outDir = path.resolve(REPO_ROOT, process.env.MT_SCENARIO_OUT ?? path.join(".e2e", "scenarios-out", String(mode)));
    mkdirSync(outDir, { recursive: true });

    // An empty world: the club's picture is only what this scenario made.
    const tables = await db.all<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
    );
    await db.run(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
    clearPipelineStubs();

    await cassette("/__cassette/scope", { club });
    const vercel = JSON.parse(readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const ticks = planTimeline(scenario, vercel.crons);
    console.log(`[scenarios] ${club}: ${scenario.steps.length} steps, ${ticks.length} ticks, ${mode}`);
    const driver = new RehearsalDriver(request, db, scenario, {
      outDir: path.join(outDir, club),
      scenarioDir: path.dirname(file),
      live: mode !== "dry",
      rate: ratePage(browser),
      nonce: club.replace(/[^a-z0-9]/g, ""),
      wideSnapshot: true,
    });
    const started = Date.now();
    let result;
    try {
      result = await driver.run(ticks);
    } finally {
      driver.restoreClock();
    }
    const model = await cassette("/__cassette/save");

    const members: Record<string, string> = {};
    for (const m of scenario.members) members[m.phone.replace(/^\+/, "")] = m.key;
    const transcript = buildTranscript({
      club,
      title: scenario.title,
      mode: String(mode),
      timezone: scenario.timezone,
      steps: scenario.steps,
      events: result.events,
      labels: await driver.idLabels(),
      members,
      final: await driver.readState(),
    });
    writeFileSync(path.join(outDir, `${club}.transcript.json`), `${JSON.stringify(transcript, null, 1)}\n`);

    // For people: the rehearsal's readable transcript, beside it.
    const names: Record<string, string> = {};
    for (const m of scenario.members) {
      names[m.key] = m.name;
      names[m.phone.replace(/^\+/, "")] = m.name;
    }
    writeFileSync(
      path.join(outDir, club, "transcript.md"),
      renderMarkdown(result.events, {
        title: `${scenario.title} (${mode})`,
        mode: mode === "dry" ? "stubbed" : "live",
        timezone: scenario.timezone,
        groups: scenario.groups,
        names,
        organisersAnnounce: (scenario.club.settings.listAnnouncer ?? "matchtime") === "organisers",
        sections: [],
      }),
    );
    const errors = transcript.steps.flatMap((s) => s.errors);
    const sent = transcript.steps.reduce((a, s) => a + s.out.length, 0);
    const run = { club, mode, ticks: ticks.length, steps: scenario.steps.length, sent, errors: errors.length, seconds: Math.round((Date.now() - started) / 1000), model };
    writeFileSync(path.join(outDir, `${club}.run.json`), `${JSON.stringify(run, null, 1)}\n`);
    console.log(`[scenarios] ${club}: ${sent} things sent, ${errors.length} errors, ${run.seconds}s; model: ${JSON.stringify(model ?? "stubbed")}`);
  });
}
