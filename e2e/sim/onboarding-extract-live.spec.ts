/**
 * THE SETUP-ANSWER READING, END TO END, ON THE REAL MODEL (2026-10-22).
 *
 * e2e/sim/onboarding.spec.ts drives the group-add onboarding with the
 * model stubbed out (no key: the regex reads the answers). This drives
 * the same route with the real EXTRACT_PROMPT on Haiku 5.5: bot-added,
 * consent, admins, then ONE Turkish when-and-where answer. The org goes
 * live with the day, kickoff, venue and size that answer gave.
 *
 *   MT_SIM_LIVE_LLM=1 tsx e2e/run.ts sim/onboarding-extract-live.spec.ts
 *
 * Skipped unless MT_SIM_LIVE_LLM=1. Spends ANTHROPIC_API_KEY_DEV only.
 * The answer turns make one setup-answer reading each (under a cent).
 */
import { test, expect, resetDb } from "../fixtures";
import { createOnboardingGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const OWNER_PHONE = "447700916000";

(LIVE ? test.describe : test.describe.skip)("the setup-answer reading LIVE (real Anthropic)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => resetDb());

  test("a Turkish when-and-where answer sets up the weekly game", async ({ request, db }) => {
    const onb = createOnboardingGroup(request);
    const added = await onb.botAdded({ groupSubject: "Cuma Kartalları", addedByPhone: OWNER_PHONE, participants: [] });
    expect(added.ok).toBe(true);
    await onb.say("EVET", { phone: OWNER_PHONE, name: "Erdal" });
    await onb.say("sadece ben", { phone: OWNER_PHONE, name: "Erdal" });
    const done = await onb.say("Cumaları akşam 9 buçukta Sim Arena'da oynuyoruz, 7'ye 7", { phone: OWNER_PHONE, name: "Erdal" });
    console.log("[onboarding-extract-live] reply:\n" + done.reply);

    const org = await db.one<{ id: string }>(`SELECT id FROM "Organisation" WHERE "whatsappGroupId" = $1`, [onb.groupId]);
    expect(org, "the org went live").toBeTruthy();
    const activity = await db.one<{ dayOfWeek: number; time: string; venue: string }>(
      `SELECT * FROM "Activity" WHERE "orgId" = $1`,
      [org!.id],
    );
    console.log("[onboarding-extract-live] activity:", JSON.stringify(activity));
    expect(activity?.dayOfWeek).toBe(5);
    expect(activity?.time).toBe("21:30");
    expect(activity?.venue).toBe("Sim Arena");
  });
});
