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
