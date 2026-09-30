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
import { composeJoinDm, joinDmPath } from "@/lib/join-dm";

const CLUB = "Sutton Football Club";
const ADDED = new Date("2026-09-29T07:57:00Z");
const URL = "https://matchtime.ai/r/k7Qp2m9";

describe("composeJoinDm: which sentence", () => {
  it("a brand new number, name unknown: the phone, a TAPPABLE signed-in link, and the promise to fill the name", () => {
    // 2026-09-30, MT Test: this DM ended "Please set their name:\n/admin/players/phones",
    // a bare path WhatsApp does not make tappable.
    const text = composeJoinDm("en", { kind: "new", club: CLUB, phone: "+447376548222" }, URL);
    expect(text).toContain("New player joined *Sutton Football Club*");
    expect(text).toContain("+447376548222");
    expect(text).toContain(`\n${URL}`);
    expect(text).toMatch(/fill in their WhatsApp name when they first post/);
    expect(text).not.toMatch(/(^|\s)\/admin/);
  });

  it("a brand new number whose WhatsApp name we know: named, and 'tap to check their details'", () => {
    const text = composeJoinDm("en", { kind: "new", club: "MT Test", phone: "+447546111893", name: "Ali" }, URL);
    expect(text).toContain("🆕 *Ali* joined *MT Test* on WhatsApp");
    expect(text).toContain("Tap to check their details");
    expect(text).toContain(URL);
    expect(text).not.toMatch(/set their name|placeholder/i);
  });

  it("joinDmPath: which admin page each shape links to", () => {
    expect(joinDmPath({ kind: "new", club: CLUB, phone: "+44" })).toBe("/admin/players/phones");
    expect(joinDmPath({ kind: "new", club: CLUB, phone: "+44", name: "Ali" })).toBe("/admin/players");
    expect(joinDmPath({ kind: "first", club: CLUB, name: "H" })).toBeNull();
    expect(joinDmPath({ kind: "first", club: CLUB, name: "H", link: { kind: "suggest", names: ["Hamza"] } })).toBe("/admin/players");
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
    }, URL);
    expect(text).toContain("*Hamzah* and *Hamza*");
    expect(text).toContain(`merge them here:\n${URL}`);
    expect(text).not.toMatch(/(^|\s)\/admin/);
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
        composeJoinDm(lang, { kind: "new", club: CLUB, phone: "+447376548222" }, URL),
        composeJoinDm(lang, { kind: "new", club: CLUB, phone: "+447376548222", name: "Ali" }, URL),
        composeJoinDm(lang, { kind: "first", club: CLUB, name: "H", link: { kind: "suggest", names: ["Hamzah"] } }, URL),
        composeJoinDm(lang, { kind: "rejoined", club: CLUB, name: "H", link: { kind: "linked", placeholderName: "H", addedAt: ADDED } }),
      ]) {
        expect(msg).not.toMatch(/[–—]/);
      }
    }
  });
});

describe("composeJoinDm: Turkish, the new shapes", () => {
  it("unnamed and named, both with the link", () => {
    const a = composeJoinDm("tr", { kind: "new", club: "Kartallar", phone: "+905551112233" }, URL);
    expect(a).toContain(URL);
    expect(a).toContain("WhatsApp adını");
    const b = composeJoinDm("tr", { kind: "new", club: "Kartallar", phone: "+905551112233", name: "Ali" }, URL);
    expect(b).toContain("*Ali*");
    expect(b).toContain(URL);
    expect(b).not.toMatch(/[—–]/);
  });
});
