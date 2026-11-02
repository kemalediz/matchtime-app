import { describe, it, expect } from "vitest";
import { adminPlayerLabel, adminPlayerInitial, adminPlayerMatches } from "../admin-player-label";

// Prod, MT Test, 2026-10-23: a partner guest with User.name NULL. The API
// hides a guest's email (null), so `(p.name ?? p.email).charAt(0)` threw
// and /admin/players showed "This page couldn't load".

describe("adminPlayerLabel", () => {
  it("uses the name when there is one", () => {
    expect(adminPlayerLabel({ name: "Ali Guestman", email: null, guestFrom: "Sutton" })).toBe("Ali Guestman");
  });

  it("falls back to the email for a nameless member", () => {
    expect(adminPlayerLabel({ name: null, email: "a@b.c" })).toBe("a@b.c");
    expect(adminPlayerLabel({ name: "   ", email: "a@b.c" })).toBe("a@b.c");
  });

  it("names a nameless guest by his club, in the club's language", () => {
    const g = { name: null, email: null, guestFrom: "Friday MT Community" };
    expect(adminPlayerLabel(g, "en")).toBe("Guest from Friday MT Community");
    expect(adminPlayerLabel(g, "tr")).toBe("Misafir: Friday MT Community");
  });

  it("never returns an empty label, even with nothing known", () => {
    expect(adminPlayerLabel({ name: null, email: null }, "en")).toBe("(unnamed)");
    expect(adminPlayerLabel({ name: null, email: null, guestFrom: "" }, "tr")).toBe("(isimsiz)");
  });
});

describe("adminPlayerInitial", () => {
  it("is the name's first letter, upper case", () => {
    expect(adminPlayerInitial({ name: "walt", email: null })).toBe("W");
  });

  it("uses the email for a nameless member", () => {
    expect(adminPlayerInitial({ name: null, email: "zed@x.y" })).toBe("Z");
  });

  it("is a neutral ? when there is no name and no email", () => {
    expect(adminPlayerInitial({ name: null, email: null, guestFrom: "Friday MT Community" })).toBe("?");
    expect(adminPlayerInitial({ name: undefined, email: undefined })).toBe("?");
  });
});

describe("adminPlayerMatches (roster search)", () => {
  it("matches on name or email, and never throws on nulls", () => {
    expect(adminPlayerMatches({ name: "Walt", email: null }, "wal")).toBe(true);
    expect(adminPlayerMatches({ name: null, email: "zed@x.y" }, "zed")).toBe(true);
    expect(adminPlayerMatches({ name: null, email: null }, "zed")).toBe(false);
  });
});

// Prod, 2026-11-02: a new club's WhatsApp import (participant-sync.ts) makes
// Users with a phone but no name and a synthetic `wa-sync+…@matchtime.local`
// email. The roster showed 26 rows of "wa-syn...". A nameless player is now
// labelled by his phone; a placeholder email is never shown.
describe("nameless players imported from the WhatsApp group", () => {
  const imported = { name: null, email: "wa-sync+player-ab12-lx9@matchtime.local", phoneNumber: "+447700900123" };

  it("labels a nameless player by his phone, UK formatted", () => {
    expect(adminPlayerLabel(imported, "en")).toBe("+44 7700 900123");
    expect(adminPlayerLabel({ ...imported, phoneNumber: "+905321234567" }, "tr")).toBe("+905321234567");
  });

  it("never shows a placeholder email as the label", () => {
    for (const email of [
      "wa-sync+player-ab12-lx9@matchtime.local",
      "phone+447700900123@matchtime.local",
      "wa-447700900999@placeholder.matchtime",
    ]) {
      const label = adminPlayerLabel({ name: null, email, phoneNumber: null }, "en");
      expect(label).not.toContain("matchtime");
    }
    expect(adminPlayerLabel({ name: null, email: "wa-sync+x@matchtime.local", phoneNumber: null }, "en")).toBe("(unnamed)");
    expect(adminPlayerLabel({ name: null, email: "wa-sync+x@matchtime.local", phoneNumber: null }, "tr")).toBe("(isimsiz)");
  });

  it("reads the number out of a wa-<digits>@placeholder.matchtime email when no phone is set", () => {
    expect(adminPlayerLabel({ name: null, email: "wa-447700900999@placeholder.matchtime", phoneNumber: null }, "en")).toBe("+44 7700 900999");
  });

  it("still shows a real email when there is no phone", () => {
    expect(adminPlayerLabel({ name: null, email: "a@b.c", phoneNumber: null })).toBe("a@b.c");
  });

  it("prefers the phone over a real email", () => {
    expect(adminPlayerLabel({ name: null, email: "a@b.c", phoneNumber: "+447700900123" })).toBe("+44 7700 900123");
  });

  it("keeps the name and the guest label ahead of the phone", () => {
    expect(adminPlayerLabel({ ...imported, name: "Walt" })).toBe("Walt");
    expect(adminPlayerLabel({ ...imported, guestFrom: "Sutton" }, "en")).toBe("Guest from Sutton");
  });

  it("never takes the avatar initial from a placeholder email", () => {
    expect(adminPlayerInitial(imported)).toBe("?");
    expect(adminPlayerInitial({ name: null, email: "phone+447700900123@matchtime.local" })).toBe("?");
    expect(adminPlayerInitial({ name: null, email: "zed@x.y", phoneNumber: "+447700900123" })).toBe("Z");
  });

  it("search matches the phone digits, typed with or without spaces or +", () => {
    expect(adminPlayerMatches(imported, "7700")).toBe(true);
    expect(adminPlayerMatches(imported, "+44 7700 900")).toBe(true);
    expect(adminPlayerMatches(imported, "447700900123")).toBe(true);
    expect(adminPlayerMatches(imported, "1111")).toBe(false);
    // A letters-only query never matches every phone via an empty digit string.
    expect(adminPlayerMatches(imported, "zed")).toBe(false);
    // UK local form, and the placeholder email is never searched.
    expect(adminPlayerMatches(imported, "07700 900123")).toBe(true);
    expect(adminPlayerMatches(imported, "sync")).toBe(false);
  });
});
