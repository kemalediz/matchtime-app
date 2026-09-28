import { describe, it, expect } from "vitest";
import { isPublicPath } from "../public-paths";

/**
 * The marketing site links to the help guides, and the ad Kemal posts in
 * other football groups points people at them. A signed-out visitor must
 * be able to read them without being bounced to /login.
 */
describe("isPublicPath", () => {
  it.each(["/help", "/help/player", "/help/admin"])(
    "lets signed-out visitors read %s",
    (p) => {
      expect(isPublicPath(p)).toBe(true);
    },
  );

  it.each(["/", "/login", "/signup", "/sitemap.xml", "/robots.txt", "/join/abc", "/r/tok", "/api/stripe/webhook"])(
    "keeps the existing public route %s public",
    (p) => {
      expect(isPublicPath(p)).toBe(true);
    },
  );

  it.each(["/admin", "/admin/players", "/profile", "/matches/123", "/helpdesk", "/help-me", "/create-org"])(
    "still gates the signed-in route %s",
    (p) => {
      expect(isPublicPath(p)).toBe(false);
    },
  );
});
