import { describe, expect, it } from "vitest";
import {
  HELP_LINK_IDS,
  SETTINGS_CARDS,
  SETTINGS_TABS,
  cardsOfTab,
  initialSettingsTab,
  parseSettingsTab,
  resolveSettingsHash,
  settingsTabHref,
  settingsUrl,
  tabOfCard,
} from "../settings-anchors";

describe("settings anchors", () => {
  it("every id the help links use is a card, and the fixed ids never move", () => {
    const ids = SETTINGS_CARDS.map((c) => c.id) as string[];
    for (const id of HELP_LINK_IDS) expect(ids, id).toContain(id);
    expect([...HELP_LINK_IDS].sort()).toEqual(
      [
        "player-pool",
        "partner-clubs",
        "pool-auto-ask",
        "play-style",
        "pool-club-share",
        "group-invite-link",
        "quiet-hours",
        "payments",
        "monthly-squad",
        "posters",
        "billing",
        "reminders",
        "attendance",
        "ratings",
        "mom",
        "teams",
        "club-details",
        "admin-group",
      ].sort(),
    );
  });

  it("ids are unique and every card is in exactly one tab", () => {
    const ids = SETTINGS_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = SETTINGS_TABS.flatMap((t) => cardsOfTab(t));
    expect(all.sort()).toEqual([...ids].sort());
    for (const t of SETTINGS_TABS) expect(cardsOfTab(t).length, t).toBeGreaterThan(0);
  });

  it("the approved tab of each card", () => {
    expect(tabOfCard("club-details")).toBe("club");
    expect(tabOfCard("monthly-squad")).toBe("matches");
    expect(tabOfCard("reminders")).toBe("matches");
    expect(tabOfCard("attendance")).toBe("players");
    expect(tabOfCard("ratings")).toBe("players");
    expect(tabOfCard("mom")).toBe("players");
    expect(tabOfCard("payments")).toBe("payments");
    expect(tabOfCard("billing")).toBe("payments");
    for (const id of ["partner-clubs", "player-pool", "play-style", "pool-auto-ask", "pool-club-share", "group-invite-link"] as const) {
      expect(tabOfCard(id), id).toBe("finding");
    }
    for (const id of ["quiet-hours", "admin-group", "posters"] as const) expect(tabOfCard(id), id).toBe("messages");
  });

  it("settingsUrl", () => {
    expect(settingsUrl("player-pool")).toBe("/admin/settings#player-pool");
    expect(settingsUrl("quiet-hours")).toBe("/admin/settings#quiet-hours");
  });

  it("a card's hash opens its tab and the card", () => {
    expect(resolveSettingsHash("#player-pool")).toEqual({ kind: "card", tab: "finding", card: "player-pool", scrollTo: "player-pool" });
    expect(resolveSettingsHash("billing")).toEqual({ kind: "card", tab: "payments", card: "billing", scrollTo: "billing" });
  });

  it("an id inside a card opens that card and scrolls to the spot", () => {
    expect(resolveSettingsHash("#club-venue")).toEqual({ kind: "card", tab: "finding", card: "partner-clubs", scrollTo: "club-venue" });
    expect(resolveSettingsHash("#wr-announce")).toMatchObject({ card: "weekly-routine", tab: "matches" });
    expect(resolveSettingsHash("#wr-pick")).toMatchObject({ card: "bench", tab: "players" });
  });

  it("ids above the tabs scroll and open nothing; anything else is ignored", () => {
    expect(resolveSettingsHash("#go-live")).toEqual({ kind: "page", scrollTo: "go-live" });
    expect(resolveSettingsHash("#learned-setup")).toEqual({ kind: "page", scrollTo: "learned-setup" });
    expect(resolveSettingsHash("#nope")).toBeNull();
    expect(resolveSettingsHash("")).toBeNull();
    expect(resolveSettingsHash("#")).toBeNull();
    expect(resolveSettingsHash(null)).toBeNull();
  });

  it("?tab= names a tab or nothing", () => {
    expect(parseSettingsTab("finding")).toBe("finding");
    expect(parseSettingsTab("Finding")).toBeNull();
    expect(parseSettingsTab("")).toBeNull();
    expect(parseSettingsTab(null)).toBeNull();
  });

  it("the tab the page opens on: hash, then ?tab=, then back from Stripe, then Club", () => {
    expect(initialSettingsTab({ hash: "#quiet-hours", search: "?tab=players" })).toBe("messages");
    expect(initialSettingsTab({ hash: "#go-live", search: "?tab=players" })).toBe("players");
    expect(initialSettingsTab({ hash: "", search: "?tab=players" })).toBe("players");
    expect(initialSettingsTab({ hash: "", search: "?stripe=done" })).toBe("payments");
    expect(initialSettingsTab({ hash: "", search: "?tab=bogus" })).toBe("club");
    expect(initialSettingsTab({})).toBe("club");
  });

  it("choosing a tab keeps the rest of the query", () => {
    expect(settingsTabHref("players", { pathname: "/admin/settings", search: "" })).toBe("/admin/settings?tab=players");
    expect(settingsTabHref("finding", { pathname: "/admin/settings", search: "?learned=x&tab=club" })).toBe(
      "/admin/settings?learned=x&tab=finding",
    );
  });
});
