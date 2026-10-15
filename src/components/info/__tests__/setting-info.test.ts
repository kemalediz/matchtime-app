/**
 * The ⓘ beside every setting on /admin/settings (2026-10-15), rendered to
 * HTML. The popup itself only exists once tapped (the Playwright spec
 * settings-info.spec.ts opens it, checks the keyboard and the layout);
 * here we pin the closed trigger: its name in the club's language, its
 * test id, and that it says it opens a dialog.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingInfo } from "../setting-info";

describe("SettingInfo", () => {
  it("renders a closed trigger named after the setting, in English", () => {
    const html = renderToStaticMarkup(createElement(SettingInfo, { k: "rollingSquad", lang: "en" }));
    expect(html).toContain('aria-label="What is Rolling squad?"');
    expect(html).toContain('data-testid="info-setting-rollingSquad"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it("names the trigger in Turkish for a Turkish club", () => {
    const html = renderToStaticMarkup(createElement(SettingInfo, { k: "rollingSquad", lang: "tr" }));
    expect(html).toContain('aria-label="Kadro devam eder nedir?"');
  });

  it("falls back to English for an unknown language", () => {
    const html = renderToStaticMarkup(createElement(SettingInfo, { k: "attendance", lang: "xx" }));
    expect(html).toContain('aria-label="What is Attendance tracking?"');
  });
});
