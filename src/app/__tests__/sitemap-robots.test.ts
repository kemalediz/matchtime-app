import { describe, it, expect } from "vitest";
import sitemap from "../sitemap";
import robots from "../robots";

describe("sitemap", () => {
  it("lists the public help guides", () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths).toEqual(expect.arrayContaining(["/", "/help", "/help/player", "/help/admin"]));
  });

  it("lists the player pool's sign-up, never its manage page", () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths).toContain("/play");
    expect(paths).not.toContain("/play/manage");
  });

  it("lists the players' page (/players) and the pricing page (/pricing)", () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths).toContain("/players");
    expect(paths).toContain("/pricing");
  });

  it("lists the privacy policy", () => {
    expect(sitemap().map((e) => new URL(e.url).pathname)).toContain("/privacy");
  });
});

describe("robots.txt", () => {
  it("allows crawling of the public site and points at the sitemap", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    expect(rules[0].allow).toBe("/");
    expect(String(r.sitemap)).toMatch(/\/sitemap\.xml$/);
  });

  it("keeps signed-in and single-use routes out of search", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const disallow = ([] as string[]).concat(rules[0].disallow ?? []);
    for (const p of ["/admin", "/api/", "/r/", "/join/", "/profile", "/matches/", "/play/manage"]) {
      expect(disallow).toContain(p);
    }
  });
});
