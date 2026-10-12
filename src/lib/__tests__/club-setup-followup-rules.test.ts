/**
 * GO-LIVE SLICES S6 AND S7: what follows the setup DM, the pure half.
 * Every new text, exact, in English and Turkish; the admin group command
 * as the EXISTING parser reads it (the server's, and the copy of its shape
 * the Pi uses to decide what may leave a silent group); and the reminder's
 * decision from the setup DM's own job.
 */
import { describe, expect, it } from "vitest";
import {
  CLUBS_PAGE_PATH,
  OWNER_SETUP_STUCK_PURPOSE,
  REMINDER_AFTER_MS,
  SETUP_ADMIN_CODE_DM_PURPOSE,
  SETUP_REMINDER_DM_PURPOSE,
  STUCK_AFTER_MS,
  STUCK_EVENT_DETAIL,
  STUCK_REMOVED_EVENT_DETAIL,
  composeSetupAdminCommandDm,
  composeSetupReminderDm,
  ownerStuckText,
  reminderDecisionFromSetupDm,
  setupAdminCodeRefId,
  setupAdminGroupBlock,
  setupReminderKey,
  setupReminderRefId,
  setupStuckKey,
  setupStuckRefId,
  setupStuckRemovedKey,
} from "../club-setup-followup-rules";
import { ADMIN_GROUP_CODE_TTL_MS, ADMIN_GROUP_DM_CODE_TTL_MS, parseAdminGroupLinkMessage } from "../admin-channel-rules";
import { composeSetupAskDm } from "../club-setup-dm-rules";
import { CANCELLABLE_DM_PURPOSES, OWNER_DM_PURPOSES, PLATFORM_DM_PURPOSES } from "../platform-jobs";
import { t } from "../i18n/t";
import { isGoCommand } from "../club-setup-rules";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..", "..");

const NO_DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

describe("the admin group step of the setup DM", () => {
  it("English: the block, exact", () => {
    expect(setupAdminGroupBlock("en")).toBe(
      "👥 *Admin group (optional):* if your organisers have their own WhatsApp group, add me to it and send my next message there. Admin messages will then go to that group instead of to you.",
    );
  });

  it("Turkish: the block, exact", () => {
    expect(setupAdminGroupBlock("tr")).toBe(
      "👥 *Yönetici grubu (isteğe bağlı):* organizatörlerinizin kendi WhatsApp grubu varsa beni o gruba ekleyin ve bir sonraki mesajımı orada gönderin. Yönetici mesajları o zaman size değil, o gruba gider.",
    );
  });

  it("the second message is exactly the command, and nothing else", () => {
    expect(composeSetupAdminCommandDm({ lang: "en", code: "K7P3QX" })).toBe("Match Time admin group K7P3QX");
    expect(composeSetupAdminCommandDm({ lang: "tr", code: "K7P3QX" })).toBe("Match Time yönetici grubu K7P3QX");
  });

  it("the EXISTING parser reads the code out of it, with no tag, in both languages", () => {
    for (const lang of ["en", "tr"]) {
      const text = composeSetupAdminCommandDm({ lang, code: "K7P3QX" });
      expect(parseAdminGroupLinkMessage(text, { botMentioned: false }), lang).toBe("K7P3QX");
    }
  });

  it("the Pi forwards it from a silent group: its copy of the command shape is the server's, character for character", () => {
    // Only a message the Pi's own copy accepts ever leaves a silent group
    // (whatsapp-bot/src/admin-group.ts, read here and not changed). The
    // same pattern, the same folding and the same "Match Time" test mean
    // that what the server's parser reads above, the Pi forwards.
    const pi = readFileSync(path.join(REPO, "whatsapp-bot/src/admin-group.ts"), "utf8");
    const server = readFileSync(path.join(REPO, "src/lib/admin-channel-rules.ts"), "utf8");
    const pattern = /const LINK_COMMAND =\s*\n\s*(\/.+\/u);/;
    expect(pattern.exec(pi)?.[1]).toBeTruthy();
    expect(pattern.exec(pi)?.[1]).toBe(pattern.exec(server)?.[1]);
    const fold = 'toLocaleLowerCase("tr").replace(/ı/g, "i")';
    expect(pi).toContain(fold);
    expect(server).toContain(fold);
    expect(pi).toContain("/match\\s*time/.test(folded)");
    expect(server).toContain("/match\\s*time/.test(folded)");
  });

  it("the block goes in right before the GO line, in both languages, and only when it is given", () => {
    for (const lang of ["en", "tr"]) {
      const base = {
        lang,
        club: "Riverside FC",
        group: "Riverside Tuesday 5s",
        reading: { kind: "nothing" as const },
        standard: true,
        scheduleUrl: "https://mt.example/sched",
        ratingsUrl: "https://mt.example/ratings",
        settingsUrl: "https://mt.example/settings",
        freePeriod: true,
      };
      const without = composeSetupAskDm(base).split("\n\n");
      const withBlock = composeSetupAskDm({ ...base, adminGroupBlock: setupAdminGroupBlock(lang) }).split("\n\n");
      expect(withBlock).toHaveLength(without.length + 1);
      const at = withBlock.indexOf(setupAdminGroupBlock(lang));
      expect(withBlock[at - 1]).toBe(t(lang).sj_dm_ready_ratings({ url: base.ratingsUrl }));
      expect(withBlock[at + 1]).toBe(t(lang).sj_dm_ready_go({ url: base.settingsUrl, button: t(lang).sj_go_button }));
      expect(withBlock.filter((_, i) => i !== at)).toEqual(without);
    }
  });

  it("a code minted for the DM lasts 7 days; the Settings button's stays 48 hours", () => {
    expect(ADMIN_GROUP_DM_CODE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ADMIN_GROUP_CODE_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("its purpose and refId are its own, and it can be cancelled with the setup DM", () => {
    expect(SETUP_ADMIN_CODE_DM_PURPOSE).toBe("setup-admin-code");
    expect(setupAdminCodeRefId("org-a")).toBe("org-a:setup-admin-code");
    expect(PLATFORM_DM_PURPOSES).toContain("setup-admin-code");
    expect(CANCELLABLE_DM_PURPOSES).toContain("setup-admin-code");
  });
});

describe("the 24-hour reminder", () => {
  it("English, exact", () => {
    expect(composeSetupReminderDm({ lang: "en", club: "Riverside FC", group: "Riverside Tuesday 5s", settingsUrl: "https://mt.example/s" })).toBe(
      'Just checking: Riverside FC is approved, but I\'m still quiet in "Riverside Tuesday 5s". Reply *GO* when you\'re ready and I\'ll introduce myself, or check the settings first: https://mt.example/s\nI won\'t remind you again.',
    );
  });

  it("Turkish, exact: the command word is BAŞLA", () => {
    expect(composeSetupReminderDm({ lang: "tr", club: "Riverside FC", group: "Riverside Tuesday 5s", settingsUrl: "https://mt.example/s" })).toBe(
      'Küçük bir hatırlatma: Riverside FC onaylandı, ama "Riverside Tuesday 5s" grubunda hâlâ sessizim. Hazır olduğunuzda *BAŞLA* yazın, kendimi tanıtayım; ya da önce ayarlara göz atın: https://mt.example/s\nBir daha hatırlatmayacağım.',
    );
  });

  it("a group with no name", () => {
    expect(composeSetupReminderDm({ lang: "en", club: "Riverside FC", group: null, settingsUrl: "u" })).toContain("still quiet in your group. Reply");
    expect(composeSetupReminderDm({ lang: "tr", club: "Riverside FC", group: null, settingsUrl: "u" })).toContain("ama grubunuzda hâlâ sessizim.");
  });

  it("the word it asks for is one the GO handler takes, in each language", () => {
    expect(isGoCommand("GO")).toBe(true);
    expect(isGoCommand("BAŞLA")).toBe(true);
    expect(composeSetupReminderDm({ lang: "en", club: "c", group: "g", settingsUrl: "u" })).toContain("*GO*");
    expect(composeSetupReminderDm({ lang: "tr", club: "c", group: "g", settingsUrl: "u" })).toContain("*BAŞLA*");
  });

  it("goes 24 hours after the setup DM was DUE", () => {
    expect(REMINDER_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("is decided by the setup DM's own job: sent, still to come, or never", () => {
    expect(reminderDecisionFromSetupDm("sent")).toBe("send");
    expect(reminderDecisionFromSetupDm("unconfirmed")).toBe("send");
    expect(reminderDecisionFromSetupDm("queued")).toBe("wait");
    expect(reminderDecisionFromSetupDm("claimed")).toBe("wait");
    // Refused (no job at all), cancelled or failed on the Pi.
    expect(reminderDecisionFromSetupDm(null)).toBe("never");
    expect(reminderDecisionFromSetupDm(undefined)).toBe("never");
    expect(reminderDecisionFromSetupDm("failed")).toBe("never");
  });

  it("its purpose, refId and once-key are its own, and it can be cancelled", () => {
    expect(SETUP_REMINDER_DM_PURPOSE).toBe("setup-reminder");
    expect(setupReminderRefId("org-a")).toBe("org-a:setup-reminder");
    // One per SETUP DM, not one per club for ever: a club that is removed
    // from, added back and sent a NEW setup DM has a new due time, so the
    // reminder clock restarts from that one.
    const asked = new Date("2026-10-12T11:00:00Z");
    expect(setupReminderKey("org-a", asked)).toBe("org-org-a:setup-reminder:2026-10-12T11:00:00.000Z");
    expect(setupReminderKey("org-a", new Date(asked.getTime() + 1))).not.toBe(setupReminderKey("org-a", asked));
    expect(PLATFORM_DM_PURPOSES).toContain("setup-reminder");
    expect(CANCELLABLE_DM_PURPOSES).toContain("setup-reminder");
  });
});

describe("the organiser who sends the command in the players' group", () => {
  it("is told by DM, English and Turkish, exact", () => {
    expect(t("en").sj_admin_group_players_group).toBe(
      "That is your players' group, so it can't be the admin group. Add me to a separate group for the admins and send the message there.",
    );
    expect(t("tr").sj_admin_group_players_group).toBe(
      "Orası oyuncularınızın grubu, bu yüzden yönetici grubu olamaz. Beni yöneticiler için ayrı bir gruba ekleyin ve mesajı orada gönderin.",
    );
  });
});

describe("the 72-hour note to the owner", () => {
  it("the DM, exact (English only: owner copy)", () => {
    expect(ownerStuckText({ club: "Riverside FC", clubsUrl: "https://matchtime.ai/admin/clubs" })).toBe(
      "Riverside FC has been approved for 3 days and its organiser has not gone live. MatchTime is still silent in its group. You can take it live from the clubs page: https://matchtime.ai/admin/clubs",
    );
    expect(CLUBS_PAGE_PATH).toBe("/admin/clubs");
  });

  it("is due 72 hours after the approval", () => {
    expect(STUCK_AFTER_MS).toBe(72 * 60 * 60 * 1000);
  });

  it("is an owner purpose, never a platform one, with its own refId and once-keys", () => {
    expect(OWNER_SETUP_STUCK_PURPOSE).toBe("owner-setup-stuck");
    expect(OWNER_DM_PURPOSES).toContain("owner-setup-stuck");
    expect(PLATFORM_DM_PURPOSES as readonly string[]).not.toContain("owner-setup-stuck");
    expect(CANCELLABLE_DM_PURPOSES as readonly string[]).not.toContain("owner-setup-stuck");
    expect(setupStuckRefId("org-a")).toBe("org-a:setup-stuck");
    expect(setupStuckKey("org-a")).not.toBe(setupStuckRemovedKey("org-a"));
  });

  it("the ops event says, for a club MatchTime was removed from, that the owner was not messaged", () => {
    expect(STUCK_EVENT_DETAIL).toContain("has not gone live");
    expect(STUCK_REMOVED_EVENT_DETAIL).toContain("was removed from its group");
    expect(STUCK_REMOVED_EVENT_DETAIL).toContain("you were not messaged");
  });
});

describe("no dashes anywhere in the new copy", () => {
  it("English, Turkish and the owner's", () => {
    const all = [
      setupAdminGroupBlock("en"),
      setupAdminGroupBlock("tr"),
      composeSetupAdminCommandDm({ lang: "en", code: "K7P3QX" }),
      composeSetupAdminCommandDm({ lang: "tr", code: "K7P3QX" }),
      composeSetupReminderDm({ lang: "en", club: "c", group: "g", settingsUrl: "u" }),
      composeSetupReminderDm({ lang: "tr", club: "c", group: "g", settingsUrl: "u" }),
      t("en").sj_admin_group_players_group,
      t("tr").sj_admin_group_players_group,
      ownerStuckText({ club: "c", clubsUrl: "u" }),
      STUCK_EVENT_DETAIL,
      STUCK_REMOVED_EVENT_DETAIL,
    ];
    for (const s of all) expect(s).not.toMatch(NO_DASH);
  });
});
