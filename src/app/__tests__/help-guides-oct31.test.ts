import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE WEB GUIDES FOR WHAT SHIPPED ON 2026-10-31 (Kemal's rule: every
 * feature is explained in the WhatsApp help AND the web guide).
 *
 *   - /help/player#friend: the friend link (#488), as the code does it
 *     (src/lib/friend-link/*, src/lib/i18n/friend-link.en.ts).
 *   - The real tag (#482, #487) on /help, /help/player and /help/admin.
 *   - /help/admin#quiet-hours: off for a new club (#486), settings or a tag
 *     (#483).
 *
 * The page sources are read as text, like help-admin-schedule.test.ts.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
/** JSX text as a reader sees it: entities decoded, {" "} and newlines folded. */
const text = (src: string) =>
  src
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");
const section = (src: string, id: string) => {
  const start = src.indexOf(`id="${id}"`);
  if (start === -1) return "";
  const next = src.indexOf("<h2", start + 1);
  return text(src.slice(start, next === -1 ? undefined : next));
};

const LANDING = read("src/app/help/page.tsx");
const PLAYER = read("src/app/help/player/page.tsx");
const ADMIN = read("src/app/help/admin/page.tsx");
const DASH = /[–—]/;
const TAG = "type @ and pick Match Time from the list";

describe("player guide: bringing a friend (the friend link)", () => {
  const s = section(PLAYER, "friend");
  it("has its own section", () => expect(s).not.toBe(""));
  it.each([
    ["no tag needed", /no need to tag/i],
    ["the ✉️ reaction", /✉️/],
    ["a personal link by DM, one per friend", /personal link/],
    ["the form and the WhatsApp code", /fills in .* WhatsApp code/],
    ["only booked once the code is sent", /not in the game until/i],
    ["the bench when full", /bench/],
    ["the player pool", /MatchTime player pool/],
    ["what the group sees", /\(Shane's friend\) is in/],
    ["until kick-off", /until kick-off/],
    ["pulling out by WhatsApp or the button", /can't make it.*(WhatsApp|button)|button.*WhatsApp/i],
    ["paying like any guest, pay as you go in monthly clubs", /pay as you go/],
    ["organisers add someone directly", /organiser adds someone.*straight/i],
  ])("%s", (_l, re) => expect(s).toMatch(re));
  it("the old 'added and checked later' line for a player's mate is gone", () => {
    expect(text(PLAYER)).not.toContain("they're added and the organiser checks them later");
  });
  it("the reactions list has ✉️", () => expect(section(PLAYER, "emoji-reference")).toMatch(/✉️.*link for your friend/));
});

describe("the real tag, everywhere in the guides", () => {
  it("player guide: the one rule says how to tag and that the name or a reply is not enough", () => {
    const top = text(PLAYER.slice(0, PLAYER.indexOf('id="signup"')));
    expect(top).toContain(TAG);
    expect(top).toMatch(/Typing the name or replying to MatchTime is not enough/);
  });
  it("organiser guide: players' group and admin group", () => {
    const faq = section(ADMIN, "faq");
    expect(faq).toContain(TAG);
    expect(faq).toMatch(/admin group/);
    expect(faq).toMatch(/Typing the name or replying to MatchTime is not enough/);
  });
  it("help landing", () => expect(text(LANDING)).toContain(TAG));
});

describe("organiser guide: quiet hours", () => {
  const s = section(ADMIN, "quiet-hours");
  it("has its own section", () => expect(s).not.toBe(""));
  it.each([
    ["off for a new club", /new club starts with quiet hours off/i],
    ["what waits", /holds the messages it sends on its own/],
    ["what never waits", /replies to a message .* never wait/],
    ["Settings", /Settings/],
    ["by tagging", /@Match Time turn on quiet hours from 23:00 to 09:00/],
    ["off by tagging", /@Match Time turn off quiet hours/],
    ["London time", /London time/],
  ])("%s", (_l, re) => expect(s).toMatch(re));
});

describe("organiser guide: players brought by a player", () => {
  it("say they come by the friend link, and an organiser adds directly", () => {
    const s = section(ADMIN, "players");
    expect(s).toMatch(/friend link/i);
    expect(s).toMatch(/send(s)? the WhatsApp code/);
  });
});

describe("house rules", () => {
  it("no em or en dashes, no waiting list", () => {
    for (const src of [LANDING, PLAYER, ADMIN]) {
      expect(text(src)).not.toMatch(DASH);
      expect(text(src)).not.toMatch(/waiting list/i);
    }
  });
});
