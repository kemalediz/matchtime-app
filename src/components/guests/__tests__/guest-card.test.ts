/**
 * The guest card's body and the Invite to club button (pool slice L5b),
 * rendered to HTML. The dialog itself is opened by the Playwright spec
 * (e2e/web/guest-players.spec.ts).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestCardDetails, InviteToClubButton } from "../guest-card";
import type { GuestCard } from "@/lib/pool/guest-report";

const card: GuestCard = {
  userId: "u1",
  name: "Ali K",
  source: "pool",
  fromClub: null,
  sports: [
    { label: "Football", level: "Advanced" },
    { label: "Basketball", level: null },
  ],
  record: { played: 5, missed: 1 },
  gamesHere: 2,
  invite: "available",
  blocked: false,
};
const action = async () => ({ ok: true as const });
const html = (c: GuestCard, lang = "en", withAction = false) =>
  renderToStaticMarkup(createElement(GuestCardDetails, { card: c, lang, orgId: "o", inviteAction: withAction ? action : undefined }));

describe("GuestCardDetails", () => {
  it("shows the source, sports with the optional level, the turn-up record and games here", () => {
    const h = html(card);
    expect(h).toContain("MatchTime player pool");
    expect(h).toContain("Football<span");
    expect(h).toContain("Advanced");
    expect(h).toContain("Basketball");
    expect(h).toContain("Turned up to 5 of 6 games");
    expect(h).toContain("2 games with your club");
  });

  it("a partner guest names his club; a new player says so; Turkish reads Turkish", () => {
    expect(html({ ...card, source: "partner", fromClub: "Sutton Lenders" })).toContain("From Sutton Lenders");
    expect(html({ ...card, record: { played: 0, missed: 0 } })).toContain("New to MatchTime");
    const tr = html(card, "tr");
    expect(tr).toContain("MatchTime oyuncu havuzu");
    expect(tr).toContain("6 maçın 5 tanesine geldi");
    expect(tr).toContain("Kulübünüzle 2 maç");
  });
});

describe("InviteToClubButton", () => {
  const button = (state: GuestCard["invite"], withAction = true) =>
    renderToStaticMarkup(createElement(InviteToClubButton, { orgId: "o", userId: "u1", state, lang: "en", action: withAction ? action : undefined }));

  it("is not rendered until L8 hands it an action", () => {
    expect(html(card)).not.toContain("guest-invite");
    expect(button("available", false)).toBe("");
  });
  it("available: an enabled button", () => {
    const h = button("available");
    expect(h).toContain('data-testid="guest-invite"');
    expect(h).not.toMatch(/disabled=""/);
    expect(html(card, "en", true)).toContain("Invite to club");
  });
  it("unavailable: greyed out, with the reason tied to it", () => {
    const h = button("unavailable");
    expect(h).toMatch(/disabled=""/);
    expect(h).toContain('aria-describedby="guest-invite-note-u1"');
    expect(h).toContain("stopped messages from MatchTime or deleted the profile");
  });
  it("invited: says so, no button; hidden: nothing", () => {
    expect(button("invited")).toContain("Invited, waiting for an answer");
    expect(button("invited")).not.toContain("<button");
    expect(button("hidden")).toBe("");
  });
});
