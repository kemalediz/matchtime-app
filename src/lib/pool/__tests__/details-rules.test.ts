/**
 * HIS TIMES AND FORMATS, ASKED LATER (Kemal, 2026-11-04): the pure rules.
 * When the profile still holds only the short form's defaults, when the one
 * later question is due, when a DM may be his answer, and what his answer
 * changes.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_DETAILS,
  applyDetails,
  detailsInScope,
  detailsSummary,
  hoursPending,
  secondAskDue,
  type DetailsFields,
  type DetailsReading,
} from "../details-rules";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-11-10T06:00:00Z");
const WHOLE = { fromMin: 0, toMin: 1440 };
const football = (formats: number[] = [], level: string | null = null) => ({ sport: "football" as const, otherName: "", formats, level: level as never, levelText: null });
const FIELDS: DetailsFields = {
  availability: [
    { day: 2, from: "00:00", to: "24:00" },
    { day: 6, from: "00:00", to: "24:00" },
  ],
  sports: [football()],
};
const reading = (r: Partial<DetailsReading>): DetailsReading => ({ hours: [], notDays: [], formats: [], anyFormat: false, level: null, ...r });

describe("hoursPending: the profile holds only the short form's whole days", () => {
  it("is true while every range is a whole day", () => {
    expect(hoursPending([{ day: 2, ...WHOLE }, { day: 6, ...WHOLE }])).toBe(true);
  });
  it("is false once any day has hours, and for no days at all", () => {
    expect(hoursPending([{ day: 2, fromMin: 19 * 60, toMin: 1440 }, { day: 6, ...WHOLE }])).toBe(false);
    expect(hoursPending([])).toBe(false);
  });
});

describe("secondAskDue: asked at most once more, later, never nagged", () => {
  const base = { status: "active", consentAt: new Date(NOW.getTime() - 4 * DAY), hoursPending: true, answered: false, alreadyAsked: false, now: NOW };
  it(`is due ${POOL_DETAILS.secondAskAfterDays} days after he joined, while nothing is answered`, () => {
    expect(POOL_DETAILS.secondAskAfterDays).toBe(3);
    expect(secondAskDue(base)).toBe(true);
    expect(secondAskDue({ ...base, consentAt: new Date(NOW.getTime() - 2 * DAY) })).toBe(false);
  });
  it("never twice, never once he answered (even 'any time'), never once his hours are set", () => {
    expect(secondAskDue({ ...base, alreadyAsked: true })).toBe(false);
    expect(secondAskDue({ ...base, answered: true })).toBe(false);
    expect(secondAskDue({ ...base, hoursPending: false })).toBe(false);
  });
  it("only to an active profile with consent, and never out of the blue to an old one", () => {
    for (const status of ["paused", "stopped", "pending-verify"]) expect(secondAskDue({ ...base, status })).toBe(false);
    expect(secondAskDue({ ...base, consentAt: null })).toBe(false);
    expect(secondAskDue({ ...base, consentAt: new Date(NOW.getTime() - (POOL_DETAILS.secondAskWithinDays + 1) * DAY) })).toBe(false);
  });
});

describe("detailsInScope: may this DM be about his times and formats?", () => {
  const ask = { sentAt: new Date(NOW.getTime() - 3600_000), quoted: false };
  it("always for someone in no club (a pool player's DM is about the pool), asked or not", () => {
    expect(detailsInScope({ inAClub: false, profileStatus: "active", ask: null, clubDmSinceAsk: false, now: NOW })).toBe(true);
    expect(detailsInScope({ inAClub: false, profileStatus: "paused", ask, clubDmSinceAsk: false, now: NOW })).toBe(true);
  });
  it("never for a stopped profile", () => {
    expect(detailsInScope({ inAClub: false, profileStatus: "stopped", ask, clubDmSinceAsk: false, now: NOW })).toBe(false);
  });
  it("for a club member only when he answers the question: a swipe-reply, or soon after it with no club DM since", () => {
    expect(detailsInScope({ inAClub: true, profileStatus: "active", ask: { ...ask, quoted: true }, clubDmSinceAsk: true, now: NOW })).toBe(true);
    expect(detailsInScope({ inAClub: true, profileStatus: "active", ask, clubDmSinceAsk: false, now: NOW })).toBe(true);
    expect(detailsInScope({ inAClub: true, profileStatus: "active", ask, clubDmSinceAsk: true, now: NOW })).toBe(false);
    const old = { sentAt: new Date(NOW.getTime() - (POOL_DETAILS.answerWindowHours + 1) * 3600_000), quoted: false };
    expect(detailsInScope({ inAClub: true, profileStatus: "active", ask: old, clubDmSinceAsk: false, now: NOW })).toBe(false);
    expect(detailsInScope({ inAClub: true, profileStatus: "active", ask: null, clubDmSinceAsk: false, now: NOW })).toBe(false);
  });
});

describe("applyDetails: what his answer changes", () => {
  it("sets the hours of the days he named and keeps the others as they were", () => {
    const out = applyDetails(FIELDS, reading({ hours: [{ day: 2, from: "19:00", to: "24:00" }] }));
    expect(out?.availability).toEqual([
      { day: 2, from: "19:00", to: "24:00" },
      { day: 6, from: "00:00", to: "24:00" },
    ]);
  });
  it("adds a day he names, and drops one he says he can no longer do", () => {
    const out = applyDetails(FIELDS, reading({ hours: [{ day: 4, from: "20:00", to: "24:00" }], notDays: [6] }));
    expect(out?.availability).toEqual([
      { day: 2, from: "00:00", to: "24:00" },
      { day: 4, from: "20:00", to: "24:00" },
    ]);
  });
  it("never drops his last day", () => {
    const out = applyDetails({ ...FIELDS, availability: [{ day: 2, from: "00:00", to: "24:00" }] }, reading({ notDays: [2], formats: [5] }));
    expect(out?.availability).toEqual([{ day: 2, from: "00:00", to: "24:00" }]);
  });
  it("sets football's formats, 'any format' clears them, and a level goes on football", () => {
    expect(applyDetails(FIELDS, reading({ formats: [7, 5] }))?.sports).toEqual([football([5, 7])]);
    expect(applyDetails({ ...FIELDS, sports: [football([11])] }, reading({ anyFormat: true }))?.sports).toEqual([football([])]);
    expect(applyDetails(FIELDS, reading({ formats: [11], level: "intermediate" }))?.sports).toEqual([football([11], "intermediate")]);
  });
  it("drops what is not real: a bad day, a bad time, a range that ends before it starts, a format football has not", () => {
    const out = applyDetails(FIELDS, reading({ hours: [{ day: 9, from: "19:00", to: "22:00" }, { day: 2, from: "25:00", to: "26:00" }, { day: 6, from: "22:00", to: "19:00" }], formats: [6] }));
    expect(out).toBeNull();
  });
  it("is null when the answer changes nothing (any time, on days that are already any time)", () => {
    expect(applyDetails(FIELDS, reading({}))).toBeNull();
    expect(applyDetails(FIELDS, reading({ hours: [{ day: 2, from: "00:00", to: "24:00" }] }))).toBeNull();
  });
  it("leaves formats alone when he has no football row", () => {
    const out = applyDetails({ ...FIELDS, sports: [{ sport: "basketball" as never, otherName: "", formats: [3], level: null, levelText: null }] }, reading({ formats: [5], hours: [{ day: 2, from: "18:00", to: "22:00" }] }));
    expect(out?.sports).toEqual([{ sport: "basketball", otherName: "", formats: [3], level: null, levelText: null }]);
  });
});

describe("detailsSummary: what is saved, for the reply", () => {
  it("lists each day Monday first, whole days as any time, and football's formats", () => {
    expect(
      detailsSummary({
        availability: [
          { day: 0, from: "10:00", to: "12:00" },
          { day: 2, from: "19:00", to: "24:00" },
          { day: 6, from: "00:00", to: "24:00" },
        ],
        sports: [football([5, 7])],
      }),
    ).toEqual({
      days: [
        { day: 2, any: false, ranges: [{ from: "19:00", to: "24:00" }] },
        { day: 6, any: true, ranges: [] },
        { day: 0, any: false, ranges: [{ from: "10:00", to: "12:00" }] },
      ],
      formats: [5, 7],
    });
  });
});
