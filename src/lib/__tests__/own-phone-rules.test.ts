/**
 * A player's own number on /welcome and /profile is never wiped
 * (FNF 2026-10-18: Feroz left the optional field blank on /welcome and his
 * stored number became NULL, so he could no longer sign in by WhatsApp code
 * or receive DMs).
 */
import { describe, it, expect } from "vitest";
import { ownPhoneError } from "@/lib/own-phone-copy";
import { t } from "@/lib/i18n/t";
import { decideOwnPhoneWrite, decidePhoneRestore, maskPhone, phoneFromPlaceholderEmail } from "@/lib/own-phone-rules";

describe("decideOwnPhoneWrite", () => {
  const HAS = "+447700900003";

  it.each([undefined, "", "   "])("blank (%j) with a stored number keeps it", (submitted) => {
    expect(decideOwnPhoneWrite({ current: HAS, submitted })).toEqual({ kind: "keep" });
  });

  it("blank with no stored number keeps NULL (nothing written)", () => {
    expect(decideOwnPhoneWrite({ current: null, submitted: "" })).toEqual({ kind: "keep" });
  });

  it("the same number in another spelling is a no-op", () => {
    expect(decideOwnPhoneWrite({ current: HAS, submitted: "07700 900003" })).toEqual({ kind: "keep" });
    expect(decideOwnPhoneWrite({ current: HAS, submitted: "+44 7700 900003" })).toEqual({ kind: "keep" });
  });

  it("a different number when one is stored is refused: it is the sign-in number", () => {
    expect(decideOwnPhoneWrite({ current: HAS, submitted: "+447700900099" })).toEqual({
      kind: "refuse",
      reason: "locked",
    });
  });

  it("garbage when one is stored is refused as locked, never written", () => {
    expect(decideOwnPhoneWrite({ current: HAS, submitted: "abc" }).kind).toBe("refuse");
  });

  it("no stored number: a valid number is set, normalised", () => {
    expect(decideOwnPhoneWrite({ current: null, submitted: "07700 900099" })).toEqual({
      kind: "set",
      phone: "+447700900099",
    });
  });

  it("no stored number: an invalid number is refused", () => {
    expect(decideOwnPhoneWrite({ current: null, submitted: "12345" })).toEqual({ kind: "refuse", reason: "invalid" });
  });
});

describe("phoneFromPlaceholderEmail", () => {
  it("reads the digits of a wa- placeholder address", () => {
    expect(phoneFromPlaceholderEmail("wa-447700900003@placeholder.matchtime")).toBe("+447700900003");
    expect(phoneFromPlaceholderEmail("WA-905321234567@placeholder.matchtime")).toBe("+905321234567");
  });
  it.each([
    "feroz@gmail.com",
    "wa-sync+player-1@matchtime.local",
    "wa-abc@placeholder.matchtime",
    "wa-0123@placeholder.matchtime",
    "wa-447700900003@placeholder.matchtime.evil.com",
    "",
    null,
  ])("returns null for %j", (email) => {
    expect(phoneFromPlaceholderEmail(email)).toBeNull();
  });
});

describe("decidePhoneRestore", () => {
  const user = { id: "u1", email: "wa-447700900003@placeholder.matchtime", phoneNumber: null };

  it("restores when phone is NULL, digits are valid and nobody holds them", () => {
    expect(decidePhoneRestore({ user, holderId: null })).toEqual({ kind: "restore", phone: "+447700900003" });
  });
  it("refuses when the user still has a number", () => {
    expect(decidePhoneRestore({ user: { ...user, phoneNumber: "+447700900003" }, holderId: null })).toEqual({
      kind: "skip",
      reason: "has-phone",
    });
  });
  it("refuses when the email is not a wa- placeholder", () => {
    expect(decidePhoneRestore({ user: { ...user, email: "x@gmail.com" }, holderId: null })).toEqual({
      kind: "skip",
      reason: "no-placeholder-number",
    });
  });
  it("refuses when someone else holds the number", () => {
    expect(decidePhoneRestore({ user, holderId: "u2" })).toEqual({ kind: "skip", reason: "held-by-other" });
  });
});

describe("ownPhoneError (EN and TR)", () => {
  it.each(["invalid", "locked", "taken"] as const)("%s has its own sentence in both languages, with no dashes", (reason) => {
    const en = ownPhoneError(t("en"), reason);
    const tr = ownPhoneError(t("tr"), reason);
    expect(en).toBeTruthy();
    expect(tr).toBeTruthy();
    expect(tr).not.toBe(en);
    expect(en + tr).not.toMatch(/[—–]/);
  });
  it("the sign-in note reads in both languages", () => {
    expect(t("en").own_phone_signin_note).toBe("This is the number you sign in with, so it can't be changed here.");
    expect(t("tr").own_phone_signin_note).toBe("Giriş yaptığın numara bu, bu yüzden burada değiştirilemez.");
  });
});

describe("maskPhone", () => {
  it("shows only the country prefix and the last three digits", () => {
    expect(maskPhone("+447700900003")).toBe("+44*******003");
  });
});
