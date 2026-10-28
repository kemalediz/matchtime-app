/**
 * Group-simulator scenario: "@Match Time help [topic]".
 *
 * Exercises the real analyze pipeline against a CONFIGURED org whose
 * payment tracking is OFF (everything else on), proving:
 *   - tagged "@Match Time help ratings" → the ratings explainer
 *   - tagged "@Match Time help payments" (payments OFF) → the decline,
 *     NOT the full payments explainer
 *   - tagged bare "@Match Time help" → the topic menu (omits payments)
 *   - UNtagged "help" → ignored (interaction contract; no help reply)
 *
 * Since 2026-10-28 help is read like any other question: the router sends
 * it to `question` and the question extractor names the topic. Both are
 * stubbed here with what the model would say ($0); everything after is
 * the shipped code. The regex fast path is gone.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { helpFacts } from "../helpers/stub";

/** What the router and the question extractor say for a help question. */
const asHelp = (feature?: string) => ({ route: "question", facts: helpFacts(feature) });

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// Configured org: payments OFF, everything else on.
let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 14,
    features: {
      attendance: true,
      bench: true,
      teamBalancing: true,
      momVoting: true,
      playerRating: true,
      reminders: true,
      statsQa: true,
      paymentTracking: false,
    },
  })).attach(request);

test('tagged "help ratings" → the ratings explainer', async ({ request, db }) => {
  const sim = await group(request, db);
  const r = await sim.post("pete", "@Match Time help ratings", { tag: true, ...asHelp("ratings") });
  expect(r.intent).toBe("help");
  expect(r.reply).toMatch(/rate the other players out of 10/i);
});

test('tagged "help payments" (payments OFF) → how fee collection works and how to switch it on (2026-09-30)', async ({
  request,
  db,
}) => {
  const sim = await group(request, db);
  const r = await sim.post("pete", "@Match Time help payments", { tag: true, ...asHelp("payments") });
  expect(r.intent).toBe("help");
  // It used to decline; an organiser learned nothing about a feature
  // that is off by default. Now it explains and says how to turn it on.
  expect(r.reply).toMatch(/isn't switched on for this group yet/);
  expect(r.reply).toMatch(/\*Match fees: how it works\*/);
  expect(r.reply).toMatch(/\*Collect match fees\*/);
  expect(r.reply).not.toContain("/r/");
});

test('tagged bare "help" → topic menu, omits the disabled payments topic', async ({
  request,
  db,
}) => {
  const sim = await group(request, db);
  const r = await sim.post("pete", "@Match Time help", { tag: true, ...asHelp() });
  expect(r.intent).toBe("help");
  expect(r.reply).toMatch(/MatchTime help/);
  expect(r.reply).toMatch(/help ratings/); // an enabled topic
  // payments off → not in the topic menu, and the organiser's 💷 fees
  // pointer is left out of the group's help too (FNF, 2026-10-15)
  expect(r.reply).not.toMatch(/• \*@Match Time help payments\*/);
});

test('UNtagged "help" → ignored (no help reply produced)', async ({
  request,
  db,
}) => {
  const sim = await group(request, db);
  const r = await sim.post("pete", "help", { tag: false, ...asHelp() });
  // The interaction contract drops untagged commands: the `question` route
  // needs a tag, so even read as help it never becomes a "help" result.
  expect(r.intent).not.toBe("help");
  expect(r.reply ?? "").not.toMatch(/MatchTime help/);
});
