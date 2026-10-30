/**
 * THE LEGACY IN-GROUP SETUP STAYS DELETED (2026-10-30, the "no string
 * parsing" sweep). "@MatchTime set up" in a group with no club, and the
 * OnboardingSession Q&A it started, were read with regexes and word lists
 * (`onboarding-parse.ts`), and a group's language was guessed from word
 * lists (`i18n/detect.ts`). The flow was unreachable in production
 * (SELF_JOIN_ENABLED=1 refused it before anything ran; the
 * OnboardingSession table had no rows), so it was deleted, not rewritten.
 * New clubs join through self-join (`group-add.ts`), whose language is the
 * one the organiser chose.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("the legacy in-group setup and its parsers stay deleted", () => {
  it("the language guesser is gone", () => {
    expect(existsSync(path.join(ROOT, "src/lib/i18n/detect.ts"))).toBe(false);
  });

  it("onboarding-parse.ts keeps only its stage list, its TTL and its flag", () => {
    const src = read("src/lib/onboarding-parse.ts");
    for (const gone of ["parseBundleReply", "parseAdmins", "extractDayOfWeek", "extractKickoffTime", "extractWhenWhere", "regexExtract", "isCancelRequest"]) {
      expect(src, gone).not.toMatch(new RegExp(`\\b${gone}\\b`));
    }
  });

  it("the legacy turn is gone from onboarding-conversation.ts", () => {
    const src = read("src/lib/onboarding-conversation.ts");
    for (const gone of ["handleOnboardingTurn", "legacySetupLang", "extractSetupAnswers"]) {
      expect(src, gone).not.toMatch(new RegExp(`\\bfunction\\s+${gone}\\b`));
    }
  });

  it("no route or library imports a language guess or the setup parsers", () => {
    for (const rel of [
      "src/app/api/whatsapp/analyze/route.ts",
      "src/app/api/whatsapp/bot-added/route.ts",
      "src/lib/group-add.ts",
      "src/lib/setup-learning/run.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/i18n\/detect|detectGroupLang|langOfConsentReply/);
      expect(src, rel).not.toMatch(/handleOnboardingTurn|isCancelRequest|SETUP_TRIGGER/);
    }
  });
});
