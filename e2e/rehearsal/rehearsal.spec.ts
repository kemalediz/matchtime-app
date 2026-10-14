/**
 * CLUB REHEARSAL: replay a club's groups against the real server, from a
 * scenario file, and write a transcript of everything MatchTime did.
 *
 *   MT_REHEARSAL_SCENARIO=path/to/scenario.json npx tsx e2e/run.ts rehearsal/
 *
 * Optional:
 *   MT_REHEARSAL_OUT=dir   where transcript.html / transcript.md / run.json
 *                          and the graphics go (default .e2e/rehearsal-out/)
 *   REHEARSAL_LIVE=1       real model calls, on ANTHROPIC_API_KEY_DEV only
 *                          (run.ts refuses without it, never the production
 *                          key). Costs money: ask before running it.
 *
 * Without MT_REHEARSAL_SCENARIO this spec is skipped, so the ordinary e2e
 * run never plays a rehearsal. The scenario format is in scenario.ts; an
 * entirely fictional example is examples/riverside.scenario.json.
 *
 * Isolation: the same embedded Postgres and local Next server as every
 * e2e spec. No WhatsApp, no production database, no Vercel, no Pi.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "../fixtures";
import { E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import { planTimeline } from "./clock";
import { RehearsalDriver, type DriverResult } from "./driver";
import { formatLocal, parseScenario, type Scenario } from "./scenario";
import { estimateLiveCost } from "./stub-routes";
import { renderHtml, renderMarkdown, summarise } from "./transcript";

const SCENARIO = process.env.MT_REHEARSAL_SCENARIO;

test.skip(!SCENARIO, "club rehearsal: set MT_REHEARSAL_SCENARIO to a scenario file to run one");

test("club rehearsal", async ({ request, db, browser }) => {
  test.setTimeout(6 * 60 * 60 * 1000);
  const live = process.env.MT_SIM_LIVE_LLM === "1";
  if (process.env.REHEARSAL_LIVE === "1" && !live) {
    throw new Error("REHEARSAL_LIVE=1 must be run through e2e/run.ts, which switches the server to the developer key.");
  }
  const file = path.resolve(REPO_ROOT, SCENARIO!);
  const scenario = parseScenario(JSON.parse(readFileSync(file, "utf8")));
  const outDir = path.resolve(REPO_ROOT, process.env.MT_REHEARSAL_OUT ?? path.join(".e2e", "rehearsal-out"));
  mkdirSync(outDir, { recursive: true });

  const vercel = JSON.parse(readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
  const ticks = planTimeline(scenario, vercel.crons);
  console.log(`[rehearsal] ${scenario.title}: ${scenario.steps.length} steps, ${ticks.length} ticks, ${live ? "LIVE" : "stubbed"}`);

  // A person opening the rating link MatchTime DM'd them, in their own
  // browser: the real magic link, the real page, the real submit.
  const rate = async (linkPath: string, mom: string | undefined): Promise<string> => {
    const context = await browser.newContext({ baseURL: E2E_BASE_URL });
    const page = await context.newPage();
    try {
      await page.goto(linkPath);
      await page.waitForURL(/\/rate/, { timeout: 60_000 });
      let picked = "no Man of the Match picked";
      // The page renders its player cards after load: wait for the submit
      // button before looking for anyone on it.
      await page.getByRole("button", { name: /submit/i }).waitFor({ timeout: 60_000 });
      if (mom) {
        const card = page.locator("div.border-amber-200");
        await card.getByRole("button").first().waitFor({ timeout: 30_000 }).catch(() => {});
        const btn = card.getByRole("button", { name: new RegExp(mom, "i") }).first();
        if (await btn.count()) {
          await btn.click();
          picked = `Man of the Match: ${(await btn.innerText()).replace(/\s+/g, " ").trim()}`;
        } else picked = `nobody matching /${mom}/ offered for Man of the Match`;
      }
      await page.getByRole("button", { name: /submit/i }).click();
      await page.waitForURL(/\/profile\/stats/, { timeout: 60_000 });
      return `submitted (default scores; ${picked})`;
    } catch (err) {
      return `failed at ${page.url()}: ${(err as Error).message.split("\n")[0]}`;
    } finally {
      await context.close();
    }
  };
  const driver = new RehearsalDriver(request, db, scenario, { outDir, scenarioDir: path.dirname(file), live, rate });
  let result: DriverResult;
  try {
    result = await driver.run(ticks);
  } finally {
    driver.restoreClock();
    if (!live) clearPipelineStubs();
  }

  const sections = await finalSections(db, scenario, driver, result);
  const names: Record<string, string> = { approver: "MatchTime owner (approver)" };
  for (const m of scenario.members) {
    names[m.key] = m.name;
    names[m.phone.replace(/^\+/, "")] = m.name;
  }
  const { E2E } = await import("../helpers/env");
  names[E2E.APPROVER_PHONE] = "MatchTime owner (approver)";
  const organisers = (scenario.club.settings.listAnnouncer ?? "matchtime") === "organisers";
  const facts = {
    title: `${scenario.title}: club rehearsal`,
    mode: (live ? "live" : "stubbed") as "live" | "stubbed",
    timezone: scenario.timezone,
    groups: scenario.groups,
    names,
    organisersAnnounce: organisers,
    sections,
  };
  writeFileSync(path.join(outDir, "transcript.html"), renderHtml(result.events, facts));
  writeFileSync(path.join(outDir, "transcript.md"), renderMarkdown(result.events, facts));
  const summary = summarise(result.events, facts);
  writeFileSync(
    path.join(outDir, "run.json"),
    JSON.stringify(
      {
        title: scenario.title,
        mode: facts.mode,
        ticks: ticks.length,
        events: result.events.length,
        graphics: result.graphics,
        perGroup: summary.perGroup,
        mainChatViolations: summary.mainChatViolations.length,
        errors: summary.errors.map((e) => e.text),
        aiCallsMeasured: result.aiCallsMeasured,
        routerRequests: result.routerRequests,
        teamBuilds: result.teamBuilds,
        forwardedPlayerMessages: result.forwardedPlayerMessages,
      },
      null,
      2,
    ),
  );
  console.log(`[rehearsal] transcript: ${path.join(outDir, "transcript.html")}`);
  console.log(
    `[rehearsal] ${result.events.length} events, ${result.graphics.length} graphics, ${summary.errors.length} errors, ` +
      `${summary.mainChatViolations.length} posts in the players' group in organisers mode`,
  );
});

async function finalSections(
  db: TestDb,
  scenario: Scenario,
  driver: RehearsalDriver,
  result: DriverResult,
): Promise<Array<{ heading: string; lines: string[] }>> {
  const out: Array<{ heading: string; lines: string[] }> = [];
  const orgId = result.orgId;
  if (!orgId) return [{ heading: "Club", lines: ["the club was never created"] }];
  const labels = scenario.club.sport.teamLabels;
  const matches = await db.all<{ id: string; date: string; status: string; red: number | null; yellow: number | null }>(
    `SELECT m.id, to_char(m.date, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS date, m.status::text AS status, m."redScore" AS red, m."yellowScore" AS yellow
     FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE a."orgId" = $1 ORDER BY m.date`,
    [orgId],
  );
  for (const m of matches) {
    const when = formatLocal(new Date(m.date), scenario.timezone);
    const att = await db.all<{ name: string | null; status: string; paid: boolean }>(
      `SELECT u.name, a.status::text AS status, (a."paidAt" IS NOT NULL) AS paid FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
       WHERE a."matchId" = $1 ORDER BY a.position`,
      [m.id],
    );
    const by = (s: string) => att.filter((a) => a.status === s).map((a) => `${a.name ?? "?"}${a.paid ? " (paid)" : ""}`);
    const teams = await db.all<{ name: string | null; team: string }>(
      `SELECT u.name, t.team::text AS team FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId" WHERE t."matchId" = $1 ORDER BY t.id`,
      [m.id],
    );
    const mom = await db.all<{ name: string | null; n: number }>(
      `SELECT u.name, count(*)::int AS n FROM "MoMVote" v JOIN "User" u ON u.id = v."playerId" WHERE v."matchId" = $1 GROUP BY u.name ORDER BY n DESC`,
      [m.id],
    );
    const ratings = await db.count(`SELECT count(*) FROM "Rating" WHERE "matchId" = $1`, [m.id]);
    out.push({
      heading: `Match ${when} (${m.status})`,
      lines: [
        `In (${by("CONFIRMED").length}): ${by("CONFIRMED").join(", ") || "nobody"}`,
        `Waiting list: ${by("BENCH").join(", ") || "nobody"}`,
        `Out: ${by("DROPPED").join(", ") || "nobody"}`,
        `${labels[0]}: ${teams.filter((t) => t.team === "RED").map((t) => t.name).join(", ") || "no teams"}`,
        `${labels[1]}: ${teams.filter((t) => t.team === "YELLOW").map((t) => t.name).join(", ") || "no teams"}`,
        `Score: ${m.red === null && m.yellow === null ? "none" : `${labels[0]} ${m.red ?? "?"} - ${m.yellow ?? "?"} ${labels[1]}`}`,
        `Man of the Match votes: ${mom.map((v) => `${v.name} ${v.n}`).join(", ") || "none"}`,
        `Ratings given: ${ratings}`,
      ],
    });
  }

  const phones = new Set(scenario.members.map((m) => m.phone));
  const made = await db.all<{ name: string | null; phone: string | null; role: string }>(
    `SELECT u.name, u."phoneNumber" AS phone, m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE m."orgId" = $1 ORDER BY u.name`,
    [orgId],
  );
  const strangers = made.filter((u) => !u.phone || !phones.has(u.phone));
  out.push({
    heading: "Members MatchTime created that are not people in the groups (names it could not match)",
    lines: strangers.length ? strangers.map((u) => `${u.name ?? "(no name)"} ${u.phone ? `(${u.phone})` : "(no phone)"} ${u.role}`) : ["none"],
  });
  const aliases = await db.all<{ alias: string; name: string | null }>(
    `SELECT a.alias, u.name FROM "UserAlias" a JOIN "User" u ON u.id = a."userId" WHERE a."orgId" = $1`,
    [orgId],
  ).catch(() => []);
  if (aliases.length) out.push({ heading: "Nicknames MatchTime learned", lines: aliases.map((a) => `${a.alias} → ${a.name}`) });

  const pasteReplies = result.events.filter(
    (e) => e.from === "matchtime" && e.meta?.via === "admin-group reply" && e.replyTo !== undefined && /paste|list|squad|YES/i.test(String(result.events[e.replyTo]?.meta?.handledBy ?? "")),
  );
  out.push({
    heading: "MatchTime's answers to lists pasted in the admin group",
    lines: pasteReplies.length ? pasteReplies.map((e) => `${formatLocal(e.at, scenario.timezone)}  ${(e.text ?? "").replace(/\n/g, " / ")}`) : ["none"],
  });

  const pay = result.events.filter((e) => (e.from === "matchtime" || e.from === "platform") && /pay|£|paid|owe/i.test(e.text ?? ""));
  out.push({
    heading: "Payment messages",
    lines: pay.length
      ? pay.map((e) => `${formatLocal(e.at, scenario.timezone)}  ${"dm" in e.channel ? `DM ${e.channel.dm}` : "group" in e.channel ? e.channel.group : "system"}: ${(e.text ?? "").replace(/\n/g, " / ").slice(0, 200)}`)
      : ["none"],
  });

  // What one live pass would call. Router: one call per request that the
  // budget ledger saw reach a model under the stubs (route-independent).
  // Extractor: under the stubs only messages given an attendance or score
  // route reach one; live, the model may route more, so the upper bound
  // assumes every forwarded message could.
  const extractorStub = Math.max(0, result.aiCallsMeasured - result.routerRequests);
  const low = estimateLiveCost({
    routerCalls: result.routerRequests,
    extractorCalls: extractorStub,
    otherCalls: { "rating adjuster": result.teamBuilds, "DM classifier": result.dmClassifierCandidates },
  });
  const high = estimateLiveCost({
    routerCalls: result.routerRequests,
    extractorCalls: Math.max(extractorStub, result.forwardedPlayerMessages),
    otherCalls: { "rating adjuster": result.teamBuilds, "DM classifier": result.dmClassifierCandidates },
  });
  out.push({
    heading: "One LIVE pass would make (estimate; not run)",
    lines: [
      ...low.lines.map((l) => `${l.kind}: ${l.calls} call(s), about $${l.usd.toFixed(3)} (${l.basis})`),
      `Total: ${low.totalCalls} calls, about $${low.totalUsd.toFixed(2)} if the model routes chat as the stubs did; up to ${high.totalCalls} calls, about $${high.totalUsd.toFixed(2)}, if every forwarded players' message also reached an extractor.`,
      `Measured under the stubs: ${result.aiCallsMeasured} budgeted model call(s) across ${result.routerRequests} request(s) that reached the router; ${result.forwardedPlayerMessages} players' messages forwarded.`,
    ],
  });
  void driver;
  return out;
}
