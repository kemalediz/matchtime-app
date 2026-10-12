/**
 * The weekly game's fee per player, as typed on /admin/activities
 * (go-live slice D3, 2026-10-12). Pure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ACTIVITY_FEE, activityFeeText, parseActivityFee } from "../activity-fee";
import { t } from "../i18n/t";

describe("parseActivityFee", () => {
  it("empty, null and undefined mean no fee", () => {
    for (const raw of ["", "   ", null, undefined]) expect(parseActivityFee(raw), String(raw)).toEqual({ ok: true, fee: null });
  });
  it("reads pounds, with pence, a comma or a pound sign", () => {
    expect(parseActivityFee("6")).toEqual({ ok: true, fee: 6 });
    expect(parseActivityFee(" 6.5 ")).toEqual({ ok: true, fee: 6.5 });
    expect(parseActivityFee("6,50")).toEqual({ ok: true, fee: 6.5 });
    expect(parseActivityFee("£7.25")).toEqual({ ok: true, fee: 7.25 });
    expect(parseActivityFee(8)).toEqual({ ok: true, fee: 8 });
    expect(parseActivityFee(String(MAX_ACTIVITY_FEE))).toEqual({ ok: true, fee: 100 });
  });
  it("refuses zero, a negative, too much, three decimals and anything that is not an amount", () => {
    for (const raw of ["0", "-5", "100.01", "250", "6.505", "six", "6 each", "1e2", Number.NaN, Infinity, {}, true]) {
      expect(parseActivityFee(raw), String(raw)).toEqual({ ok: false });
    }
  });
});

describe("activityFeeText", () => {
  it("whole pounds bare, pence to two places, nothing for no fee", () => {
    expect(activityFeeText(6)).toBe("6");
    expect(activityFeeText(6.5)).toBe("6.50");
    expect(activityFeeText(null)).toBe("");
    expect(activityFeeText(undefined)).toBe("");
    expect(activityFeeText(0)).toBe("");
  });
  it("round-trips through the form", () => {
    for (const fee of [6, 6.5, 7.25, 100]) expect(parseActivityFee(activityFeeText(fee))).toEqual({ ok: true, fee });
  });
});

describe("the words on the weekly game page, in English and Turkish", () => {
  it("the field, its hint, its refusal and the line on the list", () => {
    expect(t("en").act_fee_label).toBe("Fee per player (£), optional");
    expect(t("tr").act_fee_label).toBe("Kişi başı ücret (£), isteğe bağlı");
    expect(t("en").act_fee_hint).toBe("What each player pays for one game. Leave it empty if it changes from week to week.");
    expect(t("tr").act_fee_hint).toBe("Her oyuncunun bir maç için ödediği tutar. Haftadan haftaya değişiyorsa boş bırakın.");
    expect(t("en").act_fee_invalid).toBe("Enter a fee like 6 or 6.50, at most £100.");
    expect(t("tr").act_fee_invalid).toBe("6 veya 6.50 gibi bir ücret girin, en fazla £100.");
    expect(t("en").act_fee_split).toBe("This game splits the pitch cost between who played, so there is no fixed fee per player.");
    expect(t("tr").act_fee_split).toBe("Bu maçta saha ücreti oynayanlar arasında bölüşülüyor, bu yüzden kişi başı sabit bir ücret yok.");
    expect(t("en").act_fee_row({ fee: "6.50" })).toBe("£6.50 a player");
    expect(t("tr").act_fee_row({ fee: "6.50" })).toBe("kişi başı £6.50");
  });
});

describe("the server action never writes what it was not asked to", () => {
  const action = readFileSync(path.join(__dirname, "..", "..", "app", "actions", "activities.ts"), "utf8");
  it("everything it writes comes out of activityUpdateData, and the request is never handed to Prisma", () => {
    expect(action).toContain("activityUpdateData(formData, { feeSplitTotal: activity.feeSplitTotal })");
    expect(action).toContain("if (!update.ok) throw new Error(update.error);");
    expect(action).not.toMatch(/data:\s*formData/);
  });
});
