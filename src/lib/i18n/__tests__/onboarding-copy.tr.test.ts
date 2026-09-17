/**
 * THE TURKISH SELF-SETUP COPY, RENDERED FOR REVIEW.
 *
 * `__snapshots__/onboarding.tr.snap` is the document the owner (a native
 * speaker) reads to review the Turkish of the self-setup flow: the
 * intro, every question, every confirmation, the completion post, the
 * three DMs, the how-to block and the help replies, each rendered with
 * realistic values. Every case here has an English twin in
 * copy-golden.test.ts, so the two documents can be read side by side.
 *
 * Re-record with `npx vitest run onboarding-copy.tr -u` after a copy
 * change, and read the diff: it is the review.
 *
 * Only the onboarding keys are rendered here on purpose: the rest of
 * the Turkish table is being written in parallel (Phase 2 of the
 * multi-language design) and gets its own review document.
 */
import { describe, it, expect } from "vitest";
import {
  buildAdminMagicLinkDm,
  buildAdminsAck,
  buildBotAddedIntro,
  buildCoAdminMagicLinkDm,
  buildConsentAck,
  buildEnrichmentReviewDm,
  buildGroupAddCompletionPost,
  buildHelpReply,
  buildHowToUseMe,
} from "../../onboarding-conversation";
import { RECOMMENDED_BUNDLE, EVERYTHING_BUNDLE, detailsFollowUpQuestion } from "../../onboarding-parse";
import { t } from "../t";

const ALL_ON = { attendance: true, teamBalancing: true, momVoting: true, playerRating: true, statsQa: true, reminders: true, bench: true, paymentTracking: true };
const MINIMAL = { attendance: true, teamBalancing: false, momVoting: false, playerRating: false, statsQa: false, reminders: false, bench: false, paymentTracking: false };

function cases(): Array<{ id: string; text: string }> {
  const c: Array<{ id: string; text: string }> = [];
  const add = (id: string, text: string) => c.push({ id, text });
  const L = "tr";
  const completion = { groupName: "Cuma Halı Saha", chosen: [...RECOMMENDED_BUNDLE], dayOfWeek: 5, kickoffTime: "21:30", venue: "Sim Arena", weekly: true };

  add("intro", buildBotAddedIntro(L));
  add("consent ack / admin captured", buildConsentAck(true, L));
  add("consent ack / no admin", buildConsentAck(false, L));
  add("admins ack / none", buildAdminsAck(0, L));
  add("admins ack / one", buildAdminsAck(1, L));
  add("admins ack / two", buildAdminsAck(2, L));
  add("details question / all three missing", detailsFollowUpQuestion(["day", "time", "venue"], L));
  add("details question / day only", detailsFollowUpQuestion(["day"], L));
  add("details question / time and venue", detailsFollowUpQuestion(["time", "venue"], L));
  add("completion / roster, no co-admins, DM queued", buildGroupAddCompletionPost({ ...completion, rosterCount: 12, adminsAdded: 0, adminDmQueued: true, adminName: "Erdal" }, L));
  add("completion / one person, two co-admins, no DM, no name", buildGroupAddCompletionPost({ ...completion, rosterCount: 1, adminsAdded: 2, adminDmQueued: false, adminName: null }, L));
  add("completion / everything, one-off, empty roster, one co-admin", buildGroupAddCompletionPost({ ...completion, chosen: [...EVERYTHING_BUNDLE], weekly: false, rosterCount: 0, adminsAdded: 1, adminDmQueued: true, adminName: "" }, L));
  add("completion / no group name", buildGroupAddCompletionPost({ ...completion, groupName: null, rosterCount: 0, adminsAdded: 0, adminDmQueued: false, adminName: null }, L));
  add("admin DM / no payments", buildAdminMagicLinkDm({ groupName: "Cuma Halı Saha", url: "https://mt.example/s/abc", payments: false }, L));
  add("admin DM / payments", buildAdminMagicLinkDm({ groupName: "Cuma Halı Saha", url: "https://mt.example/s/abc", payments: true }, L));
  add("admin DM / no group name", buildAdminMagicLinkDm({ groupName: null, url: "https://mt.example/s/abc", payments: false }, L));
  add("co-admin DM", buildCoAdminMagicLinkDm({ groupName: "Cuma Halı Saha", url: "https://mt.example/s/abc" }, L));
  add("co-admin DM / no group name", buildCoAdminMagicLinkDm({ groupName: null, url: "https://mt.example/s/abc" }, L));
  add("enrichment DM", buildEnrichmentReviewDm({ messagesAnalyzed: 340, groupName: "Cuma Halı Saha", playerCount: 17, url: "https://mt.example/s/abc" }, L));
  add("enrichment DM / no group name", buildEnrichmentReviewDm({ messagesAnalyzed: 12, groupName: null, playerCount: 3, url: "https://mt.example/s/abc" }, L));
  add("cancelled", t(L).onbCancelled());
  add("how to use me / everything on", buildHowToUseMe(ALL_ON, L));
  add("how to use me / attendance only", buildHowToUseMe(MINIMAL, L));
  add("how to use me / squad-from-list shape", buildHowToUseMe({ ...ALL_ON, attendance: false, paymentTracking: false }, L));
  add("help / bare, everything on", buildHelpReply(null, ALL_ON, L));
  add("help / bare, attendance only", buildHelpReply(null, MINIMAL, L));
  for (const topic of ["availability", "teams", "mom", "ratings", "reminders", "payments"] as const) {
    add(`help / ${topic}`, buildHelpReply(topic, ALL_ON, L));
  }
  add("help / topic switched off", buildHelpReply("payments", MINIMAL, L));
  return c;
}

function render(): string {
  const all = cases();
  return (
    `# MatchTime self-setup copy, language "tr"\n` +
    `# ${all.length} rendered cases. Generated by onboarding-copy.tr.test.ts; the owner's review document.\n` +
    all.map((k) => `\n### ${k.id}\n${k.text}\n`).join("")
  );
}

describe("Turkish self-setup copy, rendered for the owner's review", () => {
  it("matches the committed review document", async () => {
    await expect(render()).toMatchFileSnapshot("./__snapshots__/onboarding.tr.snap");
  });

  it("no case is English, empty, or carries a dash", () => {
    for (const k of cases()) {
      expect(k.text.length, k.id).toBeGreaterThan(0);
      expect(k.text, k.id).not.toMatch(/[—–]/);
      // A few English words that would betray an untranslated entry.
      expect(k.text, k.id).not.toMatch(/\b(the|and|you're|I'll|match fee)\b/);
    }
  });

  it("every case differs from its English twin", () => {
    const tr = cases().map((k) => k.text);
    const en = [
      buildBotAddedIntro("en"),
      buildConsentAck(true, "en"),
      buildHowToUseMe(ALL_ON, "en"),
      buildHelpReply(null, ALL_ON, "en"),
    ];
    for (const e of en) expect(tr).not.toContain(e);
  });
});
