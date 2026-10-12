/**
 * Where a sign-in may send somebody afterwards: a path on this site,
 * nothing else. `/login?callbackUrl=` is attacker-controllable (anyone
 * can hand an organiser a link), so the WhatsApp sign-in only follows it
 * when it cannot leave the site.
 */
import { describe, expect, it } from "vitest";
import { safeCallbackPath } from "../safe-callback";

describe("safeCallbackPath", () => {
  it.each(["/", "/admin", "/admin/players?tab=new", "/month/collect#top", "/matches/abc/rate"])(
    "keeps the same-site path %s",
    (p) => {
      expect(safeCallbackPath(p)).toBe(p);
    },
  );

  it.each([
    ["an absolute URL", "https://evil.example/admin"],
    ["a protocol-relative URL", "//evil.example/admin"],
    ["a backslash host", "/\\evil.example"],
    ["a backslash later in the path", "/admin\\..\\x"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a path with no leading slash", "admin"],
    ["a tab smuggled into the slashes", "/\t/evil.example"],
    ["a newline smuggled into the slashes", "/\n/evil.example"],
    ["an empty string", ""],
    ["an over-long path", "/" + "a".repeat(600)],
  ])("refuses %s", (_label, raw) => {
    expect(safeCallbackPath(raw)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ["/admin"]])("refuses the non-string %j", (raw) => {
    expect(safeCallbackPath(raw)).toBeNull();
  });
});

/**
 * Security review of PR #248 (2026-10): the validator PARSES. A path that
 * only RESOLVES to "//host" was accepted by the old prefix checks, and one
 * fallback branch of the router would have followed it off the site.
 */
describe("safeCallbackPath: review of PR #248", () => {
  it.each([
    ["a dot segment in front of a host", "/.//evil.tld"],
    ["a parent segment in front of a host", "/x/..//evil.tld"],
    ["an encoded dot segment", "/%2e//evil.tld"],
    ["an encoded parent segment", "/%2e%2e//evil.tld/a"],
    ["an upper-case encoded dot segment", "/%2E//evil.tld"],
    ["an encoded slash making a host", "/%2f/evil.tld"],
    ["an encoded slash, upper case", "/%2F%2Fevil.tld"],
    ["a doubly encoded slash", "/%252f%252fevil.tld"],
    ["an encoded backslash", "/%5cevil.tld"],
    ["an encoded tab", "/%09/evil.tld"],
    ["a scheme with one slash", "https:/evil.tld"],
    ["a doubled slash later in the path", "/admin//evil.tld"],
    ["a fullwidth slash look-alike", "/\uff0fevil.tld"],
    ["a fraction slash look-alike", "/\u2044evil.tld"],
    ["a division slash look-alike", "/\u2215evil.tld"],
    ["a fullwidth backslash look-alike", "/\uff3cevil.tld"],
    ["a DEL character", "/admin\u007f"],
    ["a broken percent escape", "/admin/%zz"],
  ])("refuses %s", (_label, raw) => {
    expect(safeCallbackPath(raw)).toBeNull();
  });

  it("what it returns is the CANONICAL path, never the raw string", () => {
    expect(safeCallbackPath("/admin/./settings")).toBe("/admin/settings");
    expect(safeCallbackPath("/admin/x/../settings?tab=1#go-live")).toBe("/admin/settings?tab=1#go-live");
    expect(safeCallbackPath("/admin/settings#go-live")).toBe("/admin/settings#go-live");
  });

  it.each([
    ["another signed link (it would sign the browser in as whoever the link is for)", "/r/k7Qp2m9"],
    ["a signed link with a query", "/r/abc.def?x=1"],
    ["the bare link root", "/r"],
    ["a signed link behind a dot segment", "/admin/../r/k7Qp2m9"],
    ["a signed link behind an encoded letter", "/%72/k7Qp2m9"],
    ["a signed link in another letter case", "/R/k7Qp2m9"],
    ["the sign-in page", "/login"],
    ["the sign-in page with a query", "/login?expired=1"],
    ["sign-up", "/signup"],
    ["sign-up, deeper", "/signup/phone"],
    ["an API route", "/api/auth/signout"],
    ["the bare API root", "/api"],
    ["a build asset", "/_next/static/x.js"],
  ])("refuses a destination that must never be reached this way: %s", (_label, raw) => {
    expect(safeCallbackPath(raw)).toBeNull();
  });

  it.each([
    // Every path a real caller passes (see the list in safe-callback.ts).
    "/admin",
    "/admin/settings",
    "/admin/settings#go-live",
    "/admin/activities",
    "/admin/players?tab=new",
    "/month",
    "/month/collect",
    "/create-org",
    "/onboarding",
    "/matches/cmabc123/rate",
    "/billing/org_1",
    "/finish-setup/sess_1",
    "/pay/match_1",
    "/profile/stats",
    // Looks like a refused prefix, is not one.
    "/rate",
    "/rules",
    "/loginhelp",
    "/apiary",
  ])("keeps the real destination %s unchanged", (p) => {
    expect(safeCallbackPath(p)).toBe(p);
  });
});
