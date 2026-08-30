/**
 * RED-first spec for the reaction text fallback.
 *
 * THE RULE AT STAKE: when a player types "in", the bot reacts ✅ (or 🪑 for
 * the bench). That reaction IS the confirmation. `Message.react()` calls
 * `this.id._serialized` and then goes through the injected page code, so on
 * a broken build it throws for every message — the attendance write has
 * already happened server-side, but the player sees NOTHING and reasonably
 * concludes the bot is dead. They re-post, or they turn up to a match
 * expecting to be on a roster they were never told they were on.
 *
 * So: when (and only when) reactions could not be delivered, say it in
 * words. Deliberately ONE message per flush for the whole batch, never one
 * per player: the reason the bot reacts instead of replying is that a reply
 * per "in" would be unbearable in a 20-person group, and a degraded path
 * must not become the spam we were avoiding.
 */
import { describe, it, expect } from "vitest";
import {
  composeReactFallback,
  reactFallbackEnabled,
  shouldSendReactFallback,
} from "./react-fallback.js";

describe("composeReactFallback", () => {
  it("returns null when nothing failed (the healthy path is silent)", () => {
    expect(composeReactFallback([])).toBeNull();
  });

  it("groups players under the emoji the bot meant to give them", () => {
    const text = composeReactFallback([
      { authorName: "Kemal", emoji: "✅" },
      { authorName: "Ibrahim", emoji: "✅" },
      { authorName: "Baki", emoji: "🪑" },
    ]);
    expect(text).not.toBeNull();
    // Labelled, because "🪑 Baki" on its own means nothing to a player.
    // The whole point of the message is that it is readable IN WORDS.
    expect(text).toContain("✅ In: Kemal, Ibrahim");
    expect(text).toContain("🪑 On the bench: Baki");
  });

  it("is ONE message, not one per player", () => {
    const text = composeReactFallback([
      { authorName: "A", emoji: "✅" },
      { authorName: "B", emoji: "✅" },
      { authorName: "C", emoji: "✅" },
    ])!;
    expect(text.split("\n").filter((l) => l.startsWith("✅")).length).toBe(1);
  });

  it("keeps the emoji groups in first-seen order", () => {
    const text = composeReactFallback([
      { authorName: "Baki", emoji: "🪑" },
      { authorName: "Kemal", emoji: "✅" },
    ])!;
    expect(text.indexOf("🪑")).toBeLessThan(text.indexOf("✅"));
  });

  it("de-duplicates a player who appears twice with the same emoji", () => {
    const text = composeReactFallback([
      { authorName: "Kemal", emoji: "✅" },
      { authorName: "Kemal", emoji: "✅" },
    ])!;
    expect(text).toContain("✅ In: Kemal");
    expect(text.match(/Kemal/g)!.length).toBe(1);
  });

  it("drops entries with no usable name rather than printing a blank or an id", () => {
    // A bare @lid number must never be shown as a player name (RC4 of the
    // 2026-06-12 Sutton Lads incident).
    expect(
      composeReactFallback([
        { authorName: null, emoji: "✅" },
        { authorName: "   ", emoji: "✅" },
      ]),
    ).toBeNull();
    const text = composeReactFallback([
      { authorName: null, emoji: "✅" },
      { authorName: "Kemal", emoji: "✅" },
    ])!;
    expect(text).toContain("✅ In: Kemal");
  });

  it("caps a very long list so one broken flush can't post a wall of text", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      authorName: `P${i}`,
      emoji: "✅",
    }));
    const text = composeReactFallback(many)!;
    expect(text).toContain("+20 more");
    expect(text).not.toContain("P25");
  });

  it("falls back to the bare emoji for one the server invents later", () => {
    // The server owns the emoji vocabulary and can add to it. An unlabelled
    // emoji is still better than dropping the player from the message.
    const text = composeReactFallback([{ authorName: "Kemal", emoji: "🎯" }])!;
    expect(text).toContain("🎯 Kemal");
    expect(text).not.toContain("undefined");
  });

  it("uses no em dashes (house writing rule)", () => {
    const text = composeReactFallback([{ authorName: "Kemal", emoji: "✅" }])!;
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });
});

describe("reactFallbackEnabled", () => {
  it("is ON by default — a player with no confirmation is the failure we are fixing", () => {
    expect(reactFallbackEnabled({})).toBe(true);
  });
  it("can be switched off from the Pi's .env without a code change", () => {
    expect(reactFallbackEnabled({ BOT_REACT_TEXT_FALLBACK: "0" })).toBe(false);
    expect(reactFallbackEnabled({ BOT_REACT_TEXT_FALLBACK: "false" })).toBe(false);
    expect(reactFallbackEnabled({ BOT_REACT_TEXT_FALLBACK: "off" })).toBe(false);
  });
  it("treats any other value as on", () => {
    expect(reactFallbackEnabled({ BOT_REACT_TEXT_FALLBACK: "1" })).toBe(true);
    expect(reactFallbackEnabled({ BOT_REACT_TEXT_FALLBACK: "yes" })).toBe(true);
  });
});

describe("shouldSendReactFallback", () => {
  it("allows the first one", () => {
    expect(shouldSendReactFallback(null, 1_000, 60_000)).toBe(true);
  });
  it("holds a second one inside the cooldown so a broken layer can't spam the group", () => {
    expect(shouldSendReactFallback(1_000, 30_000, 60_000)).toBe(false);
  });
  it("allows again once the cooldown has elapsed", () => {
    expect(shouldSendReactFallback(1_000, 61_001, 60_000)).toBe(true);
  });
});
