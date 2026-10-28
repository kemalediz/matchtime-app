/**
 * WHERE THE PLAYERS COME FROM, THE I/O (2026-10-28): the question logged
 * where it was asked (HQ or the players' group), and the line when the
 * recruit DM finds nobody new, with the offer of the club's other places.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ organisation: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const log = vi.hoisted(() => ({ recordGroupQuestion: vi.fn(), recordMatchTimeQuestion: vi.fn() }));
vi.mock("@/lib/admin-group-log", () => log);
const partners = vi.hoisted(() => ({ activePartnerChoices: vi.fn() }));
vi.mock("@/lib/partner-ask-words", () => partners);
const settings = vi.hoisted(() => ({ loadPartnerAskSettings: vi.fn() }));
vi.mock("@/lib/club-partnership", () => settings);
const flags = vi.hoisted(() => ({ poolOffersOpenForClub: vi.fn() }));
vi.mock("@/lib/pool/flags", () => flags);

import { askWhichSource, nobodyLeftReply } from "../ask-source";

const NOW = new Date("2026-10-28T11:01:00Z");
const club = (p: { partners: boolean; pool: boolean }) => {
  partners.activePartnerChoices.mockResolvedValue(p.partners ? [{ partnershipId: "p1", partnerOrgId: "o2", name: "Sutton FC" }] : []);
  settings.loadPartnerAskSettings.mockResolvedValue({ when: "ask" });
  flags.poolOffersOpenForClub.mockReturnValue(p.pool);
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({ featurePlayerPool: true });
});

describe("askWhichSource", () => {
  it("in HQ: the HQ wording, logged as HQ's question", async () => {
    const text = await askWhichSource({ orgId: "o1", lang: "en", options: ["club", "partners", "pool"], now: NOW });
    expect(text).toBe("Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?");
    expect(log.recordMatchTimeQuestion).toHaveBeenCalledWith({ orgId: "o1", askRef: "ask-source:club+partners+pool", text, now: NOW });
    expect(log.recordGroupQuestion).not.toHaveBeenCalled();
  });

  it("in the players' group: its own players are its recent players, logged as the group's question", async () => {
    const text = await askWhichSource({ orgId: "o1", lang: "en", options: ["club", "partners", "pool"], now: NOW, where: "group" });
    expect(text).toBe("Who shall I ask for players: your recent players, your partner clubs, or the MatchTime player pool?");
    expect(log.recordGroupQuestion).toHaveBeenCalledWith({ orgId: "o1", askRef: "ask-source:club+partners+pool", text, now: NOW });
    expect(log.recordMatchTimeQuestion).not.toHaveBeenCalled();
  });

  it("Turkish, in the players' group", async () => {
    expect(await askWhichSource({ orgId: "o1", lang: "tr", options: ["club", "pool"], now: NOW, where: "group" })).toBe(
      "Oyuncu için kime sorayım: son oyuncularınıza mı, yoksa MatchTime oyuncu havuzuna mı?",
    );
  });
});

describe("nobodyLeftReply: the recruit DM found nobody new", () => {
  const reply = (lang = "en") => nobodyLeftReply({ orgId: "o1", lang, matchName: "Football 9-a-side", now: NOW, where: "group" });

  it("partners and the pool: says so, offers both, and logs it as a question offering both", async () => {
    club({ partners: true, pool: true });
    const r = await reply();
    expect(r.text).toBe("None of your recent players are left to ask for *Football 9-a-side*. Want me to ask your partner clubs or the MatchTime player pool?");
    expect(r.offered).toEqual(["partners", "pool"]);
    expect(log.recordGroupQuestion).toHaveBeenCalledWith({ orgId: "o1", askRef: "ask-source:partners+pool", text: r.text, now: NOW });
  });

  it("the pool only: offers the pool", async () => {
    club({ partners: false, pool: true });
    expect((await reply()).text).toBe("None of your recent players are left to ask for *Football 9-a-side*. Want me to ask the MatchTime player pool?");
  });

  it("neither: the plain line, no question logged", async () => {
    club({ partners: false, pool: false });
    const r = await reply();
    expect(r.text).toBe("None of your recent players are left to ask for *Football 9-a-side* right now. 👍");
    expect(log.recordGroupQuestion).not.toHaveBeenCalled();
  });

  it("Turkish", async () => {
    club({ partners: true, pool: true });
    expect((await reply("tr")).text).toBe(
      "*Football 9-a-side* için son oyuncularınızdan sorulacak kimse kalmadı. Partner kulüplerinize mi, MatchTime oyuncu havuzuna mı sorayım?",
    );
  });

  it("a failed read is the plain line", async () => {
    partners.activePartnerChoices.mockRejectedValue(new Error("x"));
    settings.loadPartnerAskSettings.mockRejectedValue(new Error("x"));
    dbMock.organisation.findUnique.mockRejectedValue(new Error("x"));
    flags.poolOffersOpenForClub.mockReturnValue(false);
    expect((await reply()).offered).toEqual([]);
  });
});
