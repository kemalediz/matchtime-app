/**
 * GO-LIVE SLICE S3: what the organiser is told BEFORE approval, under the
 * hold. "I'll message you here when it's live" is false once an approved
 * club stays silent until its organiser says GO, so the connect reply and
 * the in-group ack have a held variant, chosen by SETUP_HOLD_ENABLED. With
 * the flag off both are today's text, byte for byte.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { connectReplyText } from "../connect-dm";
import { inGroupAckText } from "../group-add";
import { t } from "../i18n/t";

const before = process.env.SETUP_HOLD_ENABLED;
afterEach(() => {
  if (before === undefined) delete process.env.SETUP_HOLD_ENABLED;
  else process.env.SETUP_HOLD_ENABLED = before;
});

const P = { name: "Ali Demir", club: "Riverside FC" };

describe("the connect reply", () => {
  it("flag off (the default): today's text exactly, in both languages", () => {
    delete process.env.SETUP_HOLD_ENABLED;
    expect(connectReplyText("connected", "en", P)).toBe(t("en").sj_dm_connected({ name: "Ali", club: "Riverside FC" }));
    expect(connectReplyText("connected", "tr", P)).toBe(t("tr").sj_dm_connected({ name: "Ali", club: "Riverside FC" }));
    expect(connectReplyText("connected", "en", P)).toContain("I'll message you here when it's live.");
  });

  it("flag on: the held variant, which promises a message at approval and names the wait for GO", () => {
    process.env.SETUP_HOLD_ENABLED = "1";
    const en = connectReplyText("connected", "en", P);
    expect(en).toBe(t("en").sj_dm_connected_held({ name: "Ali", club: "Riverside FC" }));
    expect(en).toContain(
      "I'll stay quiet in the group until your club is approved, usually within a day, and you've told me to start. I'll message you here after it's approved.",
    );
    expect(en).not.toContain("when it's live");
    // No promise of how soon: the setup message waits for the chat reading
    // and for 09:00 to 23:00.
    expect(en).not.toContain("as soon as");
    expect(connectReplyText("connected", "tr", P)).toContain("Onaylandıktan sonra size buradan yazacağım.");
    expect(connectReplyText("connected", "tr", P)).not.toContain("onaylanmaz");
  });

  it("the other replies do not change with the flag", () => {
    for (const kind of ["already-connected", "expired"] as const) {
      expect(connectReplyText(kind, "en", P, true)).toBe(connectReplyText(kind, "en", P, false));
    }
  });
});

describe("the in-group ack", () => {
  it("flag off (the default): today's text exactly", () => {
    delete process.env.SETUP_HOLD_ENABLED;
    expect(inGroupAckText("en", "Riverside Tuesday 5s")).toBe(t("en").sj_dm_in_group({ group: "Riverside Tuesday 5s" }));
    expect(inGroupAckText("tr", null)).toBe(t("tr").sj_dm_in_group({ group: null }));
    expect(inGroupAckText(undefined, "G")).toBe(t(undefined).sj_dm_in_group({ group: "G" }));
  });

  it("flag on: the held variant", () => {
    process.env.SETUP_HOLD_ENABLED = "on";
    expect(inGroupAckText("en", "Riverside Tuesday 5s")).toBe(
      `Thanks, I'm in "Riverside Tuesday 5s". I'll stay quiet there until your club is approved, usually within a day, and you've told me to start. I'll message you here after it's approved.`,
    );
    expect(inGroupAckText("tr", "Kıyı Salı Maçı")).toContain("Onaylandıktan sonra size buradan yazacağım.");
    // The connect card's held line, too: no promise of how soon.
    expect(t("en").sj_card_pending_held).toContain("messages you on WhatsApp after it's approved.");
    expect(t("tr").sj_card_pending_held).toContain("onaylandıktan sonra size WhatsApp'tan yazar.");
    for (const lang of ["en", "tr"]) {
      const held = [t(lang).sj_dm_connected_held({ name: null, club: "C" }), t(lang).sj_dm_in_group_held({ group: null }), t(lang).sj_card_pending_held].join(" ");
      expect(held).not.toMatch(/as soon as|onaylanmaz/);
    }
    expect(inGroupAckText("tr", "Cuma Halı Saha")).toBe(
      `Teşekkürler, "Cuma Halı Saha" grubuna katıldım. Kulübünüz onaylanana (genellikle bir gün içinde) ve siz başlamamı söyleyene kadar orada sessiz kalacağım. Onaylandıktan sonra size buradan yazacağım.`,
    );
  });
});
