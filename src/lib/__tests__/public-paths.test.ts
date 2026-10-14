import { describe, it, expect } from "vitest";
import { isPublicPath, retiredAuthRedirect } from "../public-paths";

/**
 * 2026-10-11: WhatsApp is the only way in. The email sign-up pages are
 * gone from the product; an old link to one goes somewhere useful
 * instead of a 404, whether or not the visitor is signed in.
 */
describe("retiredAuthRedirect", () => {
  it("sends the email sign-up page to /signup", () => {
    expect(retiredAuthRedirect("/signup-email")).toBe("/signup");
  });

  it("sends the email verification page to /login", () => {
    expect(retiredAuthRedirect("/verify-email")).toBe("/login");
  });

  it.each(["/", "/login", "/signup", "/admin", "/signup-emails", "/verify-email/x"])("leaves %s alone", (p) => {
    expect(retiredAuthRedirect(p)).toBeNull();
  });
});

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

  // The badge share card is an image shared straight into WhatsApp, public
  // by cuid like the Wrapped card. The route itself 404s unless the badge
  // is earned (src/lib/badge-card.ts).
  it.each(["/api/wrapped/u1", "/api/badge-card/u1/mom-machine"])(
    "serves the public share card %s without a session",
    (p) => {
      expect(isPublicPath(p)).toBe(true);
    },
  );

  // A club's list poster or team sheet (2026-10-14): fetched by the Pi with
  // no session. The signed, short-lived token in the path is the access
  // control (src/lib/graphic-token.ts); the route 404s without one.
  it("serves a graphic by its signed token without a session", () => {
    expect(isPublicPath("/api/graphics/abc.def")).toBe(true);
    expect(isPublicPath("/api/graphicsx")).toBe(false);
  });

  it.each(["/admin", "/admin/players", "/profile", "/matches/123", "/helpdesk", "/help-me", "/create-org"])(
    "still gates the signed-in route %s",
    (p) => {
      expect(isPublicPath(p)).toBe(false);
    },
  );
});
