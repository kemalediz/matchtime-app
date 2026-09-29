/**
 * Self-join slice 4 (organiser web): the PURE rules behind the "Add
 * MatchTime to WhatsApp" button and the status card.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 4, 5.2, 7.
 *
 * No database, no clock (every function takes `now`), no model.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECT_CODE_ALPHABET,
  CONNECT_CODE_PARSER,
  CONNECT_CODE_TTL_MS,
  MAX_CODES_PER_CLUB_PER_DAY,
  MAX_NEW_CLUBS_PER_DAY,
  APPROVED_CARD_DAYS,
  PLAYERS_PER_SIDE_OPTIONS,
  connectPrefill,
  deriveConnectCard,
  formatPhoneForDisplay,
  generateConnectCode,
  langFromAcceptLanguage,
  londonMidnight,
  sportForPlayersPerSide,
  validateWeeklyGame,
  waMeLink,
  type ConnectRow,
} from "../club-connect-rules";

const NOW = new Date("2026-09-29T12:00:00Z");
const MIN = 60_000;

describe("the numbers in section 7 (caps 4 and 5)", () => {
  it("a code lives 60 minutes, a club gets 3 a day, the site takes 10 new clubs a day", () => {
    expect(CONNECT_CODE_TTL_MS).toBe(60 * MIN);
    expect(MAX_CODES_PER_CLUB_PER_DAY).toBe(3);
    expect(MAX_NEW_CLUBS_PER_DAY).toBe(10);
  });
});

describe("connect codes", () => {
  it("the alphabet has no 0, O, 1, I or L", () => {
    for (const bad of ["0", "O", "1", "I", "L"]) expect(CONNECT_CODE_ALPHABET).not.toContain(bad);
    expect(CONNECT_CODE_ALPHABET).toHaveLength(31);
  });

  it("every generated code is 4 characters from the alphabet, and the plan's parser reads it", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateConnectCode();
      expect(code).toMatch(/^[A-Z2-9]{4}$/);
      for (const ch of code) expect(CONNECT_CODE_ALPHABET).toContain(ch);
      expect(`Connect Riverside FC, code ${code}`.match(CONNECT_CODE_PARSER)?.[1]).toBe(code);
    }
  });

  it("uses the random source it is given (deterministic in tests)", () => {
    let i = 0;
    const seq = [0, 1, 2, 30];
    expect(generateConnectCode(() => seq[i++])).toBe(
      CONNECT_CODE_ALPHABET[0] + CONNECT_CODE_ALPHABET[1] + CONNECT_CODE_ALPHABET[2] + CONNECT_CODE_ALPHABET[30],
    );
  });
});

describe("the prefilled WhatsApp message", () => {
  it("English and Turkish, with the club name and the code", () => {
    expect(connectPrefill("en", "Riverside FC", "7KQ2")).toBe("Connect Riverside FC, code 7KQ2");
    expect(connectPrefill("tr", "Riverside FC", "7KQ2")).toBe("Riverside FC kulübünü bağla, kod 7KQ2");
  });

  it("the plan's server parser reads the code from both, and from an edited text", () => {
    for (const text of [
      connectPrefill("en", "Riverside FC", "7KQ2"),
      connectPrefill("tr", "Kartallar", "7KQ2"),
      "hi, connect my club please. code: 7kq2",
    ]) {
      expect(text.match(CONNECT_CODE_PARSER)?.[1]?.toUpperCase()).toBe("7KQ2");
    }
  });

  it("an unknown language falls back to English", () => {
    expect(connectPrefill("de", "Riverside FC", "7KQ2")).toBe("Connect Riverside FC, code 7KQ2");
  });

  it("the wa.me link carries the number (digits only) and the encoded text", () => {
    expect(waMeLink("+44 7700 900777", "Riverside FC kulübünü bağla, kod 7KQ2")).toBe(
      "https://wa.me/447700900777?text=Riverside%20FC%20kul%C3%BCb%C3%BCn%C3%BC%20ba%C4%9Fla%2C%20kod%207KQ2",
    );
  });
});

describe("langFromAcceptLanguage: the picker's default", () => {
  it("Turkish when the browser prefers Turkish, English otherwise", () => {
    expect(langFromAcceptLanguage("tr-TR,tr;q=0.9,en;q=0.8")).toBe("tr");
    expect(langFromAcceptLanguage("en-GB,en;q=0.9,tr;q=0.8")).toBe("en");
    expect(langFromAcceptLanguage("de-DE")).toBe("en");
    expect(langFromAcceptLanguage(null)).toBe("en");
    expect(langFromAcceptLanguage("")).toBe("en");
  });
});

describe("the weekly game", () => {
  it("offers 4 to 11 players per side", () => {
    expect([...PLAYERS_PER_SIDE_OPTIONS]).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("5, 7, 8 and 11 use the football presets", () => {
    expect(sportForPlayersPerSide(5).preset).toBe("football-5aside");
    expect(sportForPlayersPerSide(7).preset).toBe("football-7aside");
    expect(sportForPlayersPerSide(8).preset).toBe("football-8aside");
    expect(sportForPlayersPerSide(11).preset).toBe("football-11aside");
    expect(sportForPlayersPerSide(7).playersPerTeam).toBe(7);
  });

  it("any other size is a plain football sport balanced on rating", () => {
    const six = sportForPlayersPerSide(6);
    expect(six.preset).toBeNull();
    expect(six.playersPerTeam).toBe(6);
    expect(six.balancingStrategy).toBe("rating-only");
    expect(six.positionComposition).toBeUndefined();
  });

  it("validates day, time, venue and size", () => {
    const ok = { dayOfWeek: 2, time: "21:30", venue: "Goals Wembley", playersPerSide: 7 };
    expect(validateWeeklyGame(ok)).toEqual({ ok: true, game: ok });
    expect(validateWeeklyGame({ ...ok, venue: "  Goals Wembley  " })).toEqual({ ok: true, game: ok });
    expect(validateWeeklyGame({ ...ok, dayOfWeek: 7 }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, dayOfWeek: -1 }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, time: "9:30" }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, time: "24:00" }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, venue: " " }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, venue: "x".repeat(121) }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, playersPerSide: 3 }).ok).toBe(false);
    expect(validateWeeklyGame({ ...ok, playersPerSide: 12 }).ok).toBe(false);
    expect(validateWeeklyGame(null).ok).toBe(false);
  });
});

describe("formatPhoneForDisplay", () => {
  it("groups a UK mobile, leaves anything else as +digits", () => {
    expect(formatPhoneForDisplay("+447700900123")).toBe("+44 7700 900123");
    expect(formatPhoneForDisplay("447700900123")).toBe("+44 7700 900123");
    expect(formatPhoneForDisplay("+905321234567")).toBe("+905321234567");
  });
});

describe("londonMidnight: where 'a day' starts for the daily caps", () => {
  it("is 00:00 London on the day `now` falls on (BST in September)", () => {
    expect(londonMidnight(NOW).toISOString()).toBe("2026-09-28T23:00:00.000Z");
  });
  it("is 00:00 GMT in winter", () => {
    expect(londonMidnight(new Date("2026-12-01T09:00:00Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});

// ── The status card ─────────────────────────────────────────────────────

function row(p: Partial<ConnectRow>): ConnectRow {
  return {
    status: "issued",
    code: "7KQ2",
    expiresAt: new Date(NOW.getTime() + 30 * MIN),
    addWindowEndsAt: null,
    lastMismatchAt: null,
    lastMismatchPhoneMasked: null,
    groupSubject: null,
    adderMatch: null,
    ...p,
  };
}

const draft = { approvalStatus: "draft", approvedAt: null };

describe("deriveConnectCard", () => {
  it("draft, no code yet: the button", () => {
    expect(deriveConnectCard({ org: draft, latest: null, now: NOW })).toEqual({ kind: "draft" });
  });

  it("a live code: waiting for the organiser's DM", () => {
    expect(deriveConnectCard({ org: draft, latest: row({}), now: NOW })).toEqual({
      kind: "issued",
      code: "7KQ2",
      mismatchFrom: null,
    });
  });

  it("a live code sent from another number: the masked number is shown", () => {
    const latest = row({ lastMismatchAt: NOW, lastMismatchPhoneMasked: "+44 77** ***123" });
    expect(deriveConnectCard({ org: draft, latest, now: NOW })).toEqual({
      kind: "issued",
      code: "7KQ2",
      mismatchFrom: "+44 77** ***123",
    });
  });

  it("an issued code past 60 minutes: expired", () => {
    const latest = row({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(deriveConnectCard({ org: draft, latest, now: NOW })).toEqual({ kind: "expired" });
    expect(deriveConnectCard({ org: draft, latest: row({ status: "expired" }), now: NOW })).toEqual({ kind: "expired" });
  });

  it("DM received: add me to your group, for 24 hours", () => {
    const latest = row({ status: "dm_verified", addWindowEndsAt: new Date(NOW.getTime() + 60 * MIN) });
    expect(deriveConnectCard({ org: draft, latest, now: NOW })).toEqual({ kind: "dm_verified" });
    const late = row({ status: "dm_verified", addWindowEndsAt: new Date(NOW.getTime() - 1) });
    expect(deriveConnectCard({ org: draft, latest: late, now: NOW })).toEqual({ kind: "expired" });
  });

  it("back in draft after a superseded, closed or removed request: the button again", () => {
    for (const status of ["superseded", "closed", "group_linked"]) {
      expect(deriveConnectCard({ org: draft, latest: row({ status }), now: NOW })).toEqual({ kind: "draft" });
    }
  });

  it("pending: we're checking, and says so when someone else added MatchTime", () => {
    const org = { approvalStatus: "pending", approvedAt: null };
    const mine = row({ status: "group_linked", groupSubject: "Riverside Tuesday 5s", adderMatch: "phone" });
    expect(deriveConnectCard({ org, latest: mine, now: NOW })).toEqual({
      kind: "pending",
      group: "Riverside Tuesday 5s",
      addedByOther: false,
    });
    expect(deriveConnectCard({ org, latest: { ...mine, adderMatch: "lid" }, now: NOW })).toMatchObject({ addedByOther: false });
    for (const adderMatch of ["other-organiser-present", "unknown", "mismatch"]) {
      expect(deriveConnectCard({ org, latest: { ...mine, adderMatch }, now: NOW })).toMatchObject({ addedByOther: true });
    }
  });

  it("approved: 'you're live' for a week after approval, then nothing", () => {
    const latest = row({ status: "closed", groupSubject: "Riverside Tuesday 5s" });
    const fresh = { approvalStatus: "approved", approvedAt: new Date(NOW.getTime() - 60 * MIN) };
    expect(deriveConnectCard({ org: fresh, latest, now: NOW })).toEqual({ kind: "approved", group: "Riverside Tuesday 5s" });
    const old = { approvalStatus: "approved", approvedAt: new Date(NOW.getTime() - APPROVED_CARD_DAYS * 24 * 60 * MIN - 1) };
    expect(deriveConnectCard({ org: old, latest, now: NOW })).toEqual({ kind: "hidden" });
  });

  it("an existing club (approved, never through self-join) never sees the card", () => {
    expect(deriveConnectCard({ org: { approvalStatus: "approved", approvedAt: null }, latest: null, now: NOW })).toEqual({
      kind: "hidden",
    });
  });

  it("rejected: we can't take this group on; suspended: nothing", () => {
    expect(deriveConnectCard({ org: { approvalStatus: "rejected", approvedAt: null }, latest: null, now: NOW })).toEqual({
      kind: "rejected",
    });
    expect(deriveConnectCard({ org: { approvalStatus: "suspended", approvedAt: NOW }, latest: null, now: NOW })).toEqual({
      kind: "hidden",
    });
  });
});
