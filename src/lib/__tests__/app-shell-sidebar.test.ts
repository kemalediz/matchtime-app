import { describe, it, expect } from "vitest";
import { shouldShowSidebar } from "../app-shell-sidebar";

describe("shouldShowSidebar", () => {
  it("hides the app sidebar on the help guides for signed-out visitors", () => {
    for (const p of ["/help", "/help/player", "/help/admin"]) {
      expect(shouldShowSidebar(p, "unauthenticated")).toBe(false);
    }
  });

  it("keeps the sidebar on the help guides for signed-in users", () => {
    for (const p of ["/help", "/help/player", "/help/admin"]) {
      expect(shouldShowSidebar(p, "authenticated")).toBe(true);
    }
  });

  it("shows the privacy policy full-bleed for visitors and with the sidebar for signed-in users", () => {
    expect(shouldShowSidebar("/privacy", "unauthenticated")).toBe(false);
    expect(shouldShowSidebar("/privacy", "authenticated")).toBe(true);
  });

  it("shows the players' page (/players) full-bleed for visitors, like the home page", () => {
    expect(shouldShowSidebar("/players", "unauthenticated")).toBe(false);
    expect(shouldShowSidebar("/players/x", "unauthenticated")).toBe(true);
  });

  it("shows the player pool's pages full-bleed, signed in or not (slice L2)", () => {
    for (const status of ["authenticated", "unauthenticated", "loading"] as const) {
      expect(shouldShowSidebar("/play", status)).toBe(false);
      expect(shouldShowSidebar("/play/manage", status)).toBe(false);
    }
    expect(shouldShowSidebar("/players", "authenticated")).toBe(true);
  });

  it("treats loading as signed in so a signed-in refresh does not flash", () => {
    expect(shouldShowSidebar("/help", "loading")).toBe(true);
    expect(shouldShowSidebar("/", "loading")).toBe(true);
  });

  it("keeps the existing rules", () => {
    expect(shouldShowSidebar("/", "unauthenticated")).toBe(false);
    expect(shouldShowSidebar("/", "authenticated")).toBe(true);
    expect(shouldShowSidebar("/login", "authenticated")).toBe(false);
    expect(shouldShowSidebar("/signup", "unauthenticated")).toBe(false);
    expect(shouldShowSidebar("/verify-email", "unauthenticated")).toBe(false);
    expect(shouldShowSidebar("/r/abc", "authenticated")).toBe(false);
    expect(shouldShowSidebar("/join/abc", "authenticated")).toBe(false);
    expect(shouldShowSidebar("/onboarding", "authenticated")).toBe(false);
    expect(shouldShowSidebar("/admin", "authenticated")).toBe(true);
    expect(shouldShowSidebar(null, "authenticated")).toBe(true);
  });
});
