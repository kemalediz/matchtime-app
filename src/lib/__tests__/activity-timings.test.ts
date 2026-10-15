/**
 * The weekly game's match length and sign-up cut-off on the EDIT form of
 * /admin/activities (2026-10-15). An organiser (FNF, 20:30 to 22:00)
 * could not change an existing game from 60 to 90 minutes: the field was
 * only on the create form. Pure.
 */
import { describe, expect, it } from "vitest";
import {
  DEADLINE_HOURS_MAX,
  DEADLINE_HOURS_MIN,
  MATCH_DURATION_MAX,
  MATCH_DURATION_MIN,
  activityTimingsPatch,
} from "../activity-timings";
import { activityUpdateData } from "../activity-update";
import { activitySchema } from "../validations";
import { t } from "../i18n/t";
import { infoCopy } from "../info-copy";

const STORED = { matchDurationMins: 60, deadlineHours: 5 };

describe("activityTimingsPatch", () => {
  it("sends a changed match length, as a whole number", () => {
    expect(activityTimingsPatch({ matchDurationMins: "90", deadlineHours: "5" }, STORED)).toEqual({
      ok: true,
      patch: { matchDurationMins: 90 },
    });
  });

  it("sends a changed cut-off", () => {
    expect(activityTimingsPatch({ matchDurationMins: "60", deadlineHours: "24" }, STORED)).toEqual({
      ok: true,
      patch: { deadlineHours: 24 },
    });
  });

  it("sends nothing when neither changed, so an edit of the venue never touches them", () => {
    expect(activityTimingsPatch({ matchDurationMins: "60", deadlineHours: "5" }, STORED)).toEqual({ ok: true, patch: {} });
    expect(activityTimingsPatch({ matchDurationMins: " 60 ", deadlineHours: "05" }, STORED)).toEqual({ ok: true, patch: {} });
  });

  it("a stored value outside today's bounds (Sutton's cut-off of 0) does not block an edit of something else", () => {
    const sutton = { matchDurationMins: 60, deadlineHours: 0 };
    expect(activityTimingsPatch({ matchDurationMins: "90", deadlineHours: "0" }, sutton)).toEqual({
      ok: true,
      patch: { matchDurationMins: 90 },
    });
    const long = { matchDurationMins: 240, deadlineHours: 5 };
    expect(activityTimingsPatch({ matchDurationMins: "240", deadlineHours: "6" }, long)).toEqual({
      ok: true,
      patch: { deadlineHours: 6 },
    });
  });

  it("the same bounds as the create form: 20 to 180 minutes, 1 to 48 hours", () => {
    expect(activityTimingsPatch({ matchDurationMins: "20", deadlineHours: "5" }, STORED)).toEqual({ ok: true, patch: { matchDurationMins: 20 } });
    expect(activityTimingsPatch({ matchDurationMins: "180", deadlineHours: "5" }, STORED)).toEqual({ ok: true, patch: { matchDurationMins: 180 } });
    expect(activityTimingsPatch({ matchDurationMins: "60", deadlineHours: "1" }, STORED)).toEqual({ ok: true, patch: { deadlineHours: 1 } });
    expect(activityTimingsPatch({ matchDurationMins: "60", deadlineHours: "48" }, STORED)).toEqual({ ok: true, patch: { deadlineHours: 48 } });
    for (const bad of ["19", "181", "0", "-90", "90.5", "", "ninety", "1e2"]) {
      expect(activityTimingsPatch({ matchDurationMins: bad, deadlineHours: "5" }, STORED), bad).toEqual({ ok: false, field: "matchDurationMins" });
    }
    for (const bad of ["0", "49", "-1", "2.5", "", "x"]) {
      expect(activityTimingsPatch({ matchDurationMins: "60", deadlineHours: bad }, STORED), bad).toEqual({ ok: false, field: "deadlineHours" });
    }
  });

  it("the bounds are the server's own (create schema and the edit's checks)", () => {
    expect([MATCH_DURATION_MIN, MATCH_DURATION_MAX, DEADLINE_HOURS_MIN, DEADLINE_HOURS_MAX]).toEqual([20, 180, 1, 48]);
    const base = { name: "Fri", sportId: "s", dayOfWeek: 5, time: "20:30", venue: "Goals" };
    expect(activitySchema.safeParse({ ...base, matchDurationMins: MATCH_DURATION_MAX }).success).toBe(true);
    expect(activitySchema.safeParse({ ...base, matchDurationMins: MATCH_DURATION_MAX + 1 }).success).toBe(false);
    expect(activitySchema.safeParse({ ...base, matchDurationMins: MATCH_DURATION_MIN - 1 }).success).toBe(false);
    const current = { feeSplitTotal: false, venue: "Goals" };
    expect(activityUpdateData({ matchDurationMins: 90 }, current)).toEqual({ ok: true, data: { matchDurationMins: 90 } });
    expect(activityUpdateData({ matchDurationMins: MATCH_DURATION_MAX + 1 }, current).ok).toBe(false);
    expect(activityUpdateData({ deadlineHours: DEADLINE_HOURS_MAX + 1 }, current).ok).toBe(false);
  });
});

describe("the words, in English and Turkish", () => {
  it("labels, hints and refusals", () => {
    expect(t("en").act_duration_label).toBe("Match duration (min)");
    expect(t("tr").act_duration_label).toBe("Maç süresi (dk)");
    expect(t("en").act_duration_invalid).toBe("Match duration must be 20 to 180 minutes.");
    expect(t("tr").act_duration_invalid).toBe("Maç süresi 20 ile 180 dakika arasında olmalı.");
    expect(t("en").act_deadline_label).toBe("Deadline (h before)");
    expect(t("tr").act_deadline_label).toBe("Son kayıt (saat önce)");
    expect(t("en").act_deadline_invalid).toBe("The deadline must be 1 to 48 hours before kick-off.");
    expect(t("tr").act_deadline_invalid).toBe("Son kayıt, maçtan 1 ile 48 saat önce olmalı.");
    expect(t("en").act_timings_hint).toMatch(/match length applies to every game of this activity/);
    expect(t("en").act_timings_hint).toMatch(/deadline applies to matches created after you save/);
    expect(t("tr").act_timings_hint).not.toBe(t("en").act_timings_hint);
  });

  it("the match length popup says what it decides, and was traced", () => {
    const en = infoCopy("en", "act_duration").paragraphs.join(" ");
    expect(infoCopy("en", "act_duration").title).toBe("Match length");
    expect(en).toMatch(/kick-off plus this many minutes/);
    expect(en).toMatch(/score/);
    expect(infoCopy("tr", "act_duration").title).toBe("Maç süresi");
  });

  it("no em or en dashes", () => {
    const DASH = /[—–]/;
    for (const lang of ["en", "tr"] as const) {
      const s = t(lang);
      for (const v of [s.act_duration_label, s.act_duration_invalid, s.act_deadline_label, s.act_deadline_invalid, s.act_timings_hint]) {
        expect(v).not.toMatch(DASH);
      }
    }
  });
});
