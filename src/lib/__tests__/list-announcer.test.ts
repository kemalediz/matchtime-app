/**
 * "Who announces the list and teams" (2026-10-14): the setting itself and
 * the admin-facing list update MatchTime sends instead of a group post.
 */
import { describe, it, expect } from "vitest";
import { normaliseListAnnouncer, organisersAnnounce } from "@/lib/list-announcer";
import { buildOrganiserListUpdate, organisersGroupReply } from "@/lib/organisers-list-copy";
import { t } from "@/lib/i18n/t";

describe("normaliseListAnnouncer / organisersAnnounce", () => {
  it("reads 'organisers' as organisers and anything else as MatchTime", () => {
    expect(normaliseListAnnouncer("organisers")).toBe("organisers");
    expect(normaliseListAnnouncer("matchtime")).toBe("matchtime");
    expect(normaliseListAnnouncer(null)).toBe("matchtime");
    expect(normaliseListAnnouncer(undefined)).toBe("matchtime");
    expect(normaliseListAnnouncer("ORGANISERS")).toBe("matchtime");
    expect(normaliseListAnnouncer("")).toBe("matchtime");
  });

  it("organisersAnnounce takes an org row or features, absent is MatchTime", () => {
    expect(organisersAnnounce({ listAnnouncer: "organisers" })).toBe(true);
    expect(organisersAnnounce({ listAnnouncer: "matchtime" })).toBe(false);
    expect(organisersAnnounce({})).toBe(false);
    expect(organisersAnnounce(null)).toBe(false);
    expect(organisersAnnounce(undefined)).toBe(false);
  });
});

const confirmed = ["Ali", "Baki", "Can"].map((name) => ({ name }));
const bench = [{ name: "Deniz" }];

describe("buildOrganiserListUpdate", () => {
  it("English: squad header with the count, the reason, the roster and the footer", () => {
    const text = buildOrganiserListUpdate({
      reason: "evening",
      activityName: "FNF",
      whenLabel: "Fri 16 Oct at 20:30",
      confirmed,
      bench,
      maxPlayers: 18,
      lang: "en",
    });
    expect(text).toContain("📋 *Squad for FNF, Fri 16 Oct at 20:30*: 3 of 18 in, 15 spaces.");
    expect(text).toContain("1. Ali");
    expect(text).toContain("Deniz");
    expect(text).toContain(t("en").oa_footer);
  });

  it("a full squad says it is full", () => {
    const text = buildOrganiserListUpdate({
      reason: "squad-complete",
      activityName: "FNF",
      whenLabel: "Fri 16 Oct at 20:30",
      confirmed,
      bench: [],
      maxPlayers: 3,
      lang: "en",
    });
    expect(text).toContain("3 of 3 in, full.");
    expect(text).toContain(t("en").oa_reason_squad_complete);
  });

  it("one space is singular", () => {
    const text = buildOrganiserListUpdate({
      reason: "evening",
      activityName: "FNF",
      whenLabel: "x",
      confirmed,
      bench: [],
      maxPlayers: 4,
      lang: "en",
    });
    expect(text).toContain("3 of 4 in, 1 space.");
  });

  it("each reason has its own line, the drop-out one names the time", () => {
    const base = { activityName: "FNF", whenLabel: "x", confirmed, bench: [], maxPlayers: 18, lang: "en" as const };
    expect(buildOrganiserListUpdate({ ...base, reason: "announce" })).toContain(t("en").oa_reason_announce);
    expect(buildOrganiserListUpdate({ ...base, reason: "list-published" })).toContain(t("en").oa_reason_list_published);
    expect(buildOrganiserListUpdate({ ...base, reason: "chase" })).toContain(t("en").oa_reason_chase);
    expect(buildOrganiserListUpdate({ ...base, reason: "dropout-reminder", dropOutTime: "21:00" })).toContain(
      "The drop-out deadline is today at 21:00.",
    );
  });

  it("an unpaid count adds one line; none adds nothing", () => {
    const base = { reason: "evening" as const, activityName: "FNF", whenLabel: "x", confirmed, bench: [], maxPlayers: 18, lang: "en" as const };
    expect(buildOrganiserListUpdate({ ...base, unpaid: 2 })).toContain("💷 2 still to pay for the last match.");
    expect(buildOrganiserListUpdate({ ...base, unpaid: 1 })).toContain("💷 1 still to pay for the last match.");
    expect(buildOrganiserListUpdate({ ...base, unpaid: null })).not.toContain("💷");
  });

  it("Turkish", () => {
    const text = buildOrganiserListUpdate({
      reason: "dropout-reminder",
      dropOutTime: "21:00",
      activityName: "FNF",
      whenLabel: "16 Ekim Cuma 20:30",
      confirmed,
      bench,
      maxPlayers: 18,
      unpaid: 2,
      lang: "tr",
    });
    expect(text).toContain("📋 *FNF kadrosu, 16 Ekim Cuma 20:30*: 18 kişilik kadroda 3 kişi var, 15 yer boş.");
    expect(text).toContain("Son çıkış saati bugün 21:00.");
    expect(text).toContain("💷 Son maç için 2 kişi henüz ödemedi.");
    expect(text).toContain(t("tr").oa_footer);
  });

  it("no em or en dashes in any new string", () => {
    for (const lang of ["en", "tr"] as const) {
      const s = t(lang);
      const all = [
        s.oa_footer,
        s.oa_reason_announce,
        s.oa_reason_list_published,
        s.oa_reason_chase,
        s.oa_reason_squad_complete,
        s.oa_relay_lead,
        s.oa_reason_dropout({ time: "21:00" }),
        s.oa_header({ activityName: "A", whenLabel: "B", confirmed: 1, maxPlayers: 2 }),
        s.oa_unpaid({ count: 2 }),
        s.oa_list_by_organisers,
        s.oa_teams_by_organisers,
        s.wr_announce_label,
        s.wr_announce_blurb,
        s.wr_announce_matchtime,
        s.wr_announce_organisers,
      ];
      for (const x of all) expect(x).not.toMatch(/[–—]/);
    }
  });
});

describe("organisersGroupReply: the analyze route's last pass when the organisers announce", () => {
  it("a bare squad marker (an IN's squad post) becomes silence", () => {
    expect(organisersGroupReply("[SQUAD]", "en")).toBeNull();
  });
  it("a lead with a marker keeps the lead, loses the marker", () => {
    expect(organisersGroupReply("Noted, Ali.\n\n[SQUAD]", "en")).toBe("Noted, Ali.");
  });
  it("a reply that lists the squad becomes the organisers' line", () => {
    const roster = "*Playing:*\n1. Ali\n2. Baki\n3. Can";
    expect(organisersGroupReply(roster, "en")).toBe("The organisers will post the list.");
    expect(organisersGroupReply(roster, "tr")).toBe("Listeyi organizatörler paylaşacak.");
  });
  it("anything else is untouched", () => {
    expect(organisersGroupReply("Kickoff is 20:30 at Powerleague.", "en")).toBe("Kickoff is 20:30 at Powerleague.");
    expect(organisersGroupReply(null, "en")).toBeNull();
  });
});
