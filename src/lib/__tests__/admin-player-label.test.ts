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
