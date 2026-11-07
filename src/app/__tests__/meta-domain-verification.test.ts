import { describe, it, expect, vi } from "vitest";

// The root layout loads Google fonts and the app shell; neither matters to
// the exported metadata, so they are stubbed to keep this a pure unit test.
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "" });
  return { Inter: font, Plus_Jakarta_Sans: font, Geist_Mono: font };
});
vi.mock("../globals.css", () => ({}));
vi.mock("@/components/providers", () => ({ Providers: () => null }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/web-analytics", () => ({ WebAnalytics: () => null }));

import { metadata } from "../layout";

describe("Meta (Facebook) domain verification", () => {
  it("publishes the facebook-domain-verification meta tag for matchtime.ai", () => {
    // Renders as <meta name="facebook-domain-verification" content="..." />
    // in <head>. Meta Business checks it to verify the domain.
    expect(metadata.verification?.other?.["facebook-domain-verification"]).toBe(
      "oaxbhekv080zxhiaamw3mqz86tu6mm",
    );
  });
});
