/**
 * The admin DM sent when somebody is added to a club's WhatsApp group.
 *
 * 2026-09-29, Sutton FC: Hamzah, a MatchTime user from another club, was
 * added to Sutton's group for the first time and the admin read
 * "🔁 Hamzah rejoined Sutton Football Club's WhatsApp group. Their
 * membership has been re-activated." Nothing was re-activated: it was his
 * first Sutton membership. "Rejoined" is now reserved for a membership
 * that had actually left.
 */
import { describe, it, expect } from "vitest";
import { composeJoinDm } from "@/lib/join-dm";

const CLUB = "Sutton Football Club";
const ADDED = new Date("2026-09-29T07:57:00Z");

describe("composeJoinDm: which sentence", () => {
  it("a brand new number: the placeholder note with the phone", () => {
    const text = composeJoinDm("en", { kind: "new", club: CLUB, phone: "+447376548222" });
    expect(text).toContain("New player joined *Sutton Football Club*");
    expect(text).toContain("+447376548222");
    expect(text).toContain("/admin/players/phones");
  });

  it("THE INCIDENT: a known user's FIRST membership says joined, never rejoined", () => {
    const text = composeJoinDm("en", { kind: "first", club: CLUB, name: "Hamzah" });
    expect(text).toContain("*Hamzah* joined *Sutton Football Club*");
    expect(text).not.toMatch(/rejoined|re-activated/i);
  });

  it("a membership that had left says rejoined and re-activated", () => {
    const text = composeJoinDm("en", { kind: "rejoined", club: CLUB, name: "Hamzah" });
    expect(text).toContain("*Hamzah* rejoined *Sutton Football Club*");
    expect(text).toContain("re-activated");
  });
});

describe("composeJoinDm: the link line", () => {
  it("a merged placeholder adds one line naming it and the day it was added", () => {
    const text = composeJoinDm("en", {
      kind: "first",
      club: CLUB,
      name: "Hamzah",
      link: { kind: "linked", placeholderName: "Hamzah", addedAt: ADDED },
    });
    expect(text).toContain("Linked to the *Hamzah* added on 29 September");
  });

  it("a possible duplicate names the candidates and points at /admin/players", () => {
    const text = composeJoinDm("en", {
      kind: "first",
      club: CLUB,
      name: "Hamzah Khan",
      link: { kind: "suggest", names: ["Hamzah", "Hamza"] },
    });
    expect(text).toContain("*Hamzah* and *Hamza*");
    expect(text).toContain("/admin/players");
  });

  it("Turkish: every shape renders in Turkish with the club and the date", () => {
    const first = composeJoinDm("tr", {
      kind: "first",
      club: "Kartallar",
      name: "Hamza",
      link: { kind: "linked", placeholderName: "Hamza", addedAt: ADDED },
    });
    expect(first).toContain("katıldı");
    expect(first).toContain("29 Eylül");
    expect(first).not.toMatch(/joined|Linked/);
    const again = composeJoinDm("tr", { kind: "rejoined", club: "Kartallar", name: "Hamza" });
    expect(again).toContain("geri döndü");
  });

  it("no em or en dashes in any shape, in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const msg of [
        composeJoinDm(lang, { kind: "new", club: CLUB, phone: "+447376548222" }),
        composeJoinDm(lang, { kind: "first", club: CLUB, name: "H", link: { kind: "suggest", names: ["Hamzah"] } }),
        composeJoinDm(lang, { kind: "rejoined", club: CLUB, name: "H", link: { kind: "linked", placeholderName: "H", addedAt: ADDED } }),
      ]) {
        expect(msg).not.toMatch(/[–—]/);
      }
    }
  });
});
