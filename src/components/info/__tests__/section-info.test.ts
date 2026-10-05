/**
 * F1 (2026-10-05): the ⓘ button every organiser section uses, rendered
 * to HTML. The popup itself only exists once tapped (the Playwright
 * specs open it); here we pin the trigger: its accessible name in the
 * club's language, its test id, and that nothing is open at first.
 */
import { describe, it, expect } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionInfo } from "../section-info";
import { InfoButton } from "../../stats/info-button";

describe("SectionInfo", () => {
  it("renders a closed trigger named in English", () => {
    const html = renderToStaticMarkup(createElement(SectionInfo, { k: "pl_seed", lang: "en" }));
    expect(html).toContain('aria-label="What is Seed rating?"');
    expect(html).toContain('data-testid="info-pl_seed"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="dialog"');
  });

  it("names the trigger in Turkish for a Turkish club", () => {
    const html = renderToStaticMarkup(createElement(SectionInfo, { k: "pl_seed", lang: "tr" }));
    expect(html).toContain('aria-label="Başlangıç puanı nedir?"');
  });

  it("falls back to English for an unknown language", () => {
    const html = renderToStaticMarkup(createElement(SectionInfo, { k: "dash_players", lang: "xx" }));
    expect(html).toContain('aria-label="What is Players?"');
  });
});

/** InfoButton's props with a body, typed (children is required). */
function button(p: Omit<ComponentProps<typeof InfoButton>, "children">): ComponentProps<typeof InfoButton> {
  return { ...p, children: "x" };
}

describe("InfoButton", () => {
  it("keeps the 'What is X?' default name the existing specs click", () => {
    const html = renderToStaticMarkup(createElement(InfoButton, button({ title: "Rolling squad" })));
    expect(html).toContain('aria-label="What is Rolling squad?"');
    expect(html).not.toContain("data-testid");
  });

  it("is a plain button that never submits a form", () => {
    const html = renderToStaticMarkup(createElement(InfoButton, button({ title: "T", testId: "t" })));
    expect(html).toMatch(/<button type="button"/);
    expect(html).toContain('data-testid="info-t"');
  });
});
