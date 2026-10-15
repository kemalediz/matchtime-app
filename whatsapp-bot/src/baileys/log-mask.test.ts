import { describe, expect, it } from "vitest";
import { maskDigits, maskIdsIn, maskJid } from "./log-mask.js";

describe("maskJid", () => {
  it("masks a phone JID in either spelling, keeping the last three digits and the server", () => {
    expect(maskJid("447700900961@s.whatsapp.net")).toBe("***961@s.whatsapp.net");
    expect(maskJid("447700900961@c.us")).toBe("***961@c.us");
    expect(maskJid("447700900961:12@s.whatsapp.net")).toBe("***961@s.whatsapp.net");
  });

  it("masks a LID", () => {
    expect(maskJid("158055467598961@lid")).toBe("***961@lid");
    expect(maskJid("158055467598961:3@lid")).toBe("***961@lid");
  });

  it("keeps a modern group id, which is not a person, and masks the creator's phone in an old-style one", () => {
    expect(maskJid("120363400000000123@g.us")).toBe("120363400000000123@g.us");
    expect(maskJid("447700900961-1600000000@g.us")).toBe("***961-1600000000@g.us");
  });

  it("is total", () => {
    expect(maskJid(null)).toBe("?");
    expect(maskJid(undefined)).toBe("?");
    expect(maskJid("status@broadcast")).toBe("status@broadcast");
    expect(maskJid("447700900961")).toBe("***961");
  });
});

describe("maskIdsIn", () => {
  it("masks every person's JID in a line, and nothing else", () => {
    expect(
      maskIdsIn(
        "[baileys][msg] upsert=notify chat=447700900961@s.whatsapp.net id=ABC age=1s sender=447700900961@c.us " +
          "lid=158055467598961:2@lid on=false_447700900962@c.us_3EB0 in 120363400000000123@g.us",
      ),
    ).toBe(
      "[baileys][msg] upsert=notify chat=***961@s.whatsapp.net id=ABC age=1s sender=***961@c.us " +
        "lid=***961@lid on=false_***962@c.us_3EB0 in 120363400000000123@g.us",
    );
  });

  it("masks the creator's phone in an old-style group id, and is idempotent", () => {
    const once = maskIdsIn("in 447700900961-1600000000@g.us");
    expect(once).toBe("in ***961-1600000000@g.us");
    expect(maskIdsIn(once)).toBe(once);
  });
});

describe("maskDigits", () => {
  it("keeps the last three", () => {
    expect(maskDigits("447700900961")).toBe("***961");
    expect(maskDigits(null)).toBe("?");
    expect(maskDigits("12")).toBe("***");
  });
});
