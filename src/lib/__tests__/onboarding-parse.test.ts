/**
 * Unit tests for the Phase 1 autonomous-onboarding pure logic
 * (src/lib/onboarding-parse.ts): consent/bundle parsing, the combined
 * when&where multi-field extraction, the details-stage transition
 * rules, and the env-flag gate. No DB, no network, no LLM.
 */
import { describe, it, expect } from "vitest";
import {
  parseBundleReply,
  parseAdmins,
  RECOMMENDED_BUNDLE,
  EVERYTHING_BUNDLE,
  extractWhenWhere,
  extractVenueFreeText,
  detailsStillMissing,
  detailsFollowUpQuestion,
  regexExtract,
  isOnboardingAutostartEnabled,
} from "@/lib/onboarding-parse";

// ───────────────────────── bundle parsing ──────────────────────────────

describe("parseBundleReply — YES (recommended bundle)", () => {
  it.each(["YES", "yes", "Yes please", "yep", "yeah", "let's do it", "YES!!", "yes 👍"])(
    "accepts standalone affirmative %j",
    (msg) => {
      const r = parseBundleReply(msg);
      expect(r).not.toBeNull();
      expect(r!.choice).toBe("yes");
      expect(r!.features).toEqual(RECOMMENDED_BUNDLE);
      expect(r!.features).not.toContain("paymentTracking");
    },
  );

  it("rejects a 'yes' buried in ordinary chat", () => {
    expect(parseBundleReply("yes mate what a game that was")).toBeNull();
    expect(parseBundleReply("yes I'll bring the bibs on saturday")).toBeNull();
  });
});

describe("parseBundleReply — EVERYTHING", () => {
  it("everything → recommended + paymentTracking", () => {
    const r = parseBundleReply("EVERYTHING");
    expect(r?.choice).toBe("everything");
    expect(r?.features).toEqual(EVERYTHING_BUNDLE);
    expect(r?.features).toContain("paymentTracking");
  });

  it.each(["the lot please", "all features", "go on then, everything"])(
    "accepts variant %j",
    (msg) => {
      expect(parseBundleReply(msg)?.choice).toBe("everything");
    },
  );

  it("everything except payments drops paymentTracking", () => {
    const r = parseBundleReply("everything except payments");
    expect(r?.choice).toBe("everything");
    expect(r?.features).not.toContain("paymentTracking");
    expect(r?.features).toContain("attendance");
  });
});

describe("parseBundleReply — named subsets", () => {
  it('"just MoM and ratings" → momVoting + playerRating only', () => {
    const r = parseBundleReply("just MoM and ratings");
    expect(r?.choice).toBe("custom");
    expect(new Set(r?.features)).toEqual(new Set(["momVoting", "playerRating"]));
  });

  it("two feature keywords without a cue still count (≥2 rule)", () => {
    const r = parseBundleReply("man of the match and the bench thing");
    expect(new Set(r?.features)).toEqual(new Set(["momVoting", "bench"]));
  });

  it("payments tracking can be named explicitly", () => {
    const r = parseBundleReply("just payment tracking and reminders");
    expect(new Set(r?.features)).toEqual(new Set(["paymentTracking", "reminders"]));
  });

  it("a single incidental keyword with no cue is NOT a selection", () => {
    // "teams" alone in banter must not start setup / crown an admin.
    expect(parseBundleReply("great teams last night lads")).toBeNull();
    expect(parseBundleReply("who rated that ref")).toBeNull();
  });
});

describe("parseBundleReply — junk falls open", () => {
  it.each(["", "   ", "anyone seen my boots?", "8-2 to us", "😂😂😂", "ok cool"])(
    "ignores %j",
    (msg) => {
      expect(parseBundleReply(msg)).toBeNull();
    },
  );
});

// ───────────────────────── admins parsing ──────────────────────────────

describe("parseAdmins — additional-admin capture", () => {
  it("single @mention → 1 admin, phone + mention present", () => {
    const r = parseAdmins("@447700900123");
    expect(r.justMe).toBe(false);
    expect(r.admins).toHaveLength(1);
    expect(r.admins[0].phone).toBeTruthy();
    expect(r.admins[0].mention).toBe("@447700900123");
  });

  it("single name + phone → 1 admin with both", () => {
    const r = parseAdmins("Kemal Ediz, 07700900123");
    expect(r.admins).toHaveLength(1);
    expect(r.admins[0].name?.toLowerCase()).toContain("kemal");
    expect(r.admins[0].phone).toBeTruthy();
  });

  it("mixed mention + name/phone (different numbers) → 2 admins", () => {
    const r = parseAdmins("@447700900123 and John 07700900111");
    expect(r.admins).toHaveLength(2);
    expect(r.admins.some((a) => a.mention === "@447700900123")).toBe(true);
    expect(r.admins.some((a) => a.name?.toLowerCase().includes("john"))).toBe(true);
  });

  it("comma / 'and' / newline separation → 3 admins", () => {
    const r = parseAdmins("Ana 07700900111\nBob 07700900222, Cem 07700900333");
    expect(r.admins).toHaveLength(3);
    const names = r.admins.map((a) => a.name?.toLowerCase());
    expect(names).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ana"),
        expect.stringContaining("bob"),
        expect.stringContaining("cem"),
      ]),
    );
  });

  it.each(["just me", "only me thanks", "nobody else", "no one else", "just us"])(
    "%j → justMe:true, no admins",
    (msg) => {
      const r = parseAdmins(msg);
      expect(r.justMe).toBe(true);
      expect(r.admins).toEqual([]);
    },
  );

  it.each(["lol", "", "👍", "idk really"])(
    "junk %j → justMe:false, no admins",
    (msg) => {
      const r = parseAdmins(msg);
      expect(r.justMe).toBe(false);
      expect(r.admins).toEqual([]);
    },
  );

  it("dedupes two entries with the same normalised phone", () => {
    const r = parseAdmins("John 07700900111 and Johnny 07700900111");
    expect(r.admins).toHaveLength(1);
    expect(r.admins[0].phone).toBeTruthy();
  });

  it("forward-compat mentions[] fold in alongside the body", () => {
    const r = parseAdmins("", ["447700900444@c.us"]);
    expect(r.admins).toHaveLength(1);
    expect(r.admins[0].phone).toBe("447700900444");
    expect(r.admins[0].mention).toBe("@447700900444");
  });

  it("an @lid mention with no usable phone is recorded with phone=null", () => {
    const r = parseAdmins("", ["1234567890@lid"]);
    expect(r.admins).toHaveLength(1);
    expect(r.admins[0].phone).toBeNull();
    expect(r.admins[0].mention).toBe("1234567890@lid");
  });
});

// ─────────────────── when & where multi-field extraction ───────────────

describe("extractWhenWhere — combined one-message answers", () => {
  it('"Tuesdays 9pm at Goals" → {day 2, 21:00, Goals}', () => {
    const r = extractWhenWhere("Tuesdays 9pm at Goals");
    expect(r.dayOfWeek).toBe(2);
    expect(r.kickoffTime).toBe("21:00");
    expect(r.venue).toBe("Goals");
  });

  it("full design example: Thursdays 9pm at PowerLeague Shoreditch, 7-a-side", () => {
    const r = extractWhenWhere("Thursdays 9pm at PowerLeague Shoreditch, 7-a-side");
    expect(r.dayOfWeek).toBe(4);
    expect(r.kickoffTime).toBe("21:00");
    expect(r.venue).toBe("PowerLeague Shoreditch");
    expect(r.playersPerSide).toBe(7);
  });

  it("24h times and 5-a-side", () => {
    const r = extractWhenWhere("we play mondays 18:30 at Goals Star City, 5 a side");
    expect(r.dayOfWeek).toBe(1);
    expect(r.kickoffTime).toBe("18:30");
    expect(r.venue).toBe("Goals Star City");
    expect(r.playersPerSide).toBe(5);
  });

  it("recurrence: weekly stated / one-off stated / default null", () => {
    expect(extractWhenWhere("every week thursdays 8pm at Goals").recurrence).toBe("weekly");
    expect(extractWhenWhere("just this once, saturday 3pm at the park").recurrence).toBe("oneoff");
    expect(extractWhenWhere("thursdays 8pm at Goals").recurrence).toBeNull();
  });

  it("partial answers leave the other fields null", () => {
    const r = extractWhenWhere("thursdays for us");
    expect(r.dayOfWeek).toBe(4);
    expect(r.kickoffTime).toBeNull();
    expect(r.venue).toBeNull();
  });
});

describe("extractVenueFreeText — venue stays FREE TEXT (no geocoding)", () => {
  it('takes the LAST "at" clause when an earlier one is a time', () => {
    expect(extractVenueFreeText("we kick off at 9 at Goals Wembley")).toBe("Goals Wembley");
  });

  it('skips a pure-time capture ("at 9pm")', () => {
    expect(extractVenueFreeText("thursdays at 9pm")).toBeNull();
  });

  it("strips a trailing format fragment", () => {
    expect(extractVenueFreeText("at PowerLeague Shoreditch 7-a-side")).toBe(
      "PowerLeague Shoreditch",
    );
  });

  it("keeps the raw string (no normalisation/geocoding)", () => {
    expect(extractVenueFreeText("9pm at the cage behind Tesco")).toBe(
      "the cage behind Tesco",
    );
  });
});

// ───────────────── details-stage state machine transitions ─────────────

describe("detailsStillMissing — stage completion rule", () => {
  const base = { dayOfWeek: null, kickoffTime: null, venue: null };

  it("all three missing right after consent", () => {
    expect(detailsStillMissing(base)).toEqual(["day", "time", "venue"]);
  });

  it("partial progress tracks exactly the gaps", () => {
    expect(detailsStillMissing({ ...base, dayOfWeek: 2 })).toEqual(["time", "venue"]);
    expect(detailsStillMissing({ ...base, dayOfWeek: 2, kickoffTime: "21:00" })).toEqual([
      "venue",
    ]);
  });

  it("complete ⇒ [] ⇒ transition to completed", () => {
    expect(
      detailsStillMissing({ dayOfWeek: 2, kickoffTime: "21:00", venue: "Goals" }),
    ).toEqual([]);
  });

  it("a combined answer merged over an empty session completes in one turn", () => {
    const ww = extractWhenWhere("Tuesdays 9pm at Goals");
    expect(
      detailsStillMissing({
        dayOfWeek: ww.dayOfWeek,
        kickoffTime: ww.kickoffTime,
        venue: ww.venue,
      }),
    ).toEqual([]);
  });

  it("follow-up copy targets only the gaps", () => {
    expect(detailsFollowUpQuestion(["venue"])).toContain("venue");
    expect(detailsFollowUpQuestion(["venue"])).not.toContain("kickoff");
    expect(detailsFollowUpQuestion(["day", "time", "venue"])).toContain(
      "when and where do you play?",
    );
  });
});

// ───────────── legacy regexExtract still behaves (moved file) ──────────

describe("regexExtract — legacy behaviour preserved after the move", () => {
  it("multi-field one message", () => {
    const r = regexExtract([{ body: "7 a side thursdays 8:30pm every week" }]);
    expect(r.playersPerSide).toBe(7);
    expect(r.dayOfWeek).toBe(4);
    expect(r.kickoffTime).toBe("20:30");
    expect(r.recurrence).toBe("weekly");
  });

  it("'everything except payments' feature selection", () => {
    const r = regexExtract([{ body: "everything except payments" }]);
    expect(r.featureSelection).not.toContain("paymentTracking");
    expect(r.featureSelection).toContain("momVoting");
  });

  it("numbered picks map to FEATURE_META order", () => {
    const r = regexExtract([{ body: "4 and 5 please" }]);
    expect(new Set(r.featureSelection)).toEqual(new Set(["momVoting", "playerRating"]));
  });
});

// ──────────────────────────── env-flag gate ────────────────────────────

describe("isOnboardingAutostartEnabled — safety flag", () => {
  it("OFF by default (undefined / empty / junk)", () => {
    expect(isOnboardingAutostartEnabled(undefined)).toBe(false);
    expect(isOnboardingAutostartEnabled("")).toBe(false);
    expect(isOnboardingAutostartEnabled("0")).toBe(false);
    expect(isOnboardingAutostartEnabled("false")).toBe(false);
    expect(isOnboardingAutostartEnabled("off")).toBe(false);
  });

  it("ON only when explicitly flipped", () => {
    expect(isOnboardingAutostartEnabled("1")).toBe(true);
    expect(isOnboardingAutostartEnabled("true")).toBe(true);
    expect(isOnboardingAutostartEnabled("on")).toBe(true);
    expect(isOnboardingAutostartEnabled(" TRUE ")).toBe(true);
  });
});
