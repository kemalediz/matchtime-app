/**
 * /play while sign-ups are paused (`isPoolSignupPaused`, review fix
 * 2026-11-15): the page says sign-ups are paused and shows no form, so it
 * must not name a game to join nor say the first game is free. The game
 * line and the offer show only while the form does.
 * Server render of the component; no database, no model: $0.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaySignup } from "../play-signup";

const LINE = "Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam";
const OFFER = "First game free for new players";

const render = (paused: boolean) =>
  renderToStaticMarkup(
    createElement(PlaySignup, {
      source: { campaignCode: "fb1", referralCode: null },
      paused,
      gameLine: LINE,
      gameOffer: OFFER,
      earlyList: false,
    }),
  );

describe("the game line and the offer while sign-ups are paused", () => {
  it("paused: neither the game line nor the offer", () => {
    const html = render(true);
    expect(html).not.toContain('data-testid="pool-game-line"');
    expect(html).not.toContain('data-testid="pool-game-offer"');
    expect(html).not.toContain(LINE);
    expect(html).not.toContain(OFFER);
  });

  it("open: both, as before", () => {
    const html = render(false);
    expect(html).toContain(LINE);
    expect(html).toContain(OFFER);
  });
});
