/**
 * The Cloud API template registry (plan MDs/whatsapp-cloud-api-plan-
 * 2026-11-04.md 3.9 and 5.6, PR C6). Every first contact purpose has a
 * template; every template has both languages; every variable is filled,
 * on one line, for every live shape of the job it serves; the URL buttons
 * carry only the suffix their fixed base leaves open.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import type { PoolOfferFacts } from "../../pool/offer-copy";
import { FIRST_CONTACT_PURPOSES } from "../../send-channel";
import { CLOUD_TEMPLATE_CATEGORIES } from "../vocab";
import {
  CLOUD_TEMPLATES,
  META_LANG,
  cloudTemplate,
  joinedTemplateName,
  metaComponents,
  placedTemplateName,
  renderTemplatePreview,
  templateBody,
  templateMessage,
  templateParams,
  type CloudTemplateFacts,
  type CloudTemplateName,
} from "../templates";

const KICKOFF = londonDateTimeToUtc("2026-10-30", "20:30");
const OFFER_LINK = "https://matchtime.ai/play/offer/abc.def";
const MANAGE = "https://matchtime.ai/r/x1Yz9";
const INVITES = "https://matchtime.ai/r/Inv42";
const GROUP = "https://chat.whatsapp.com/AbC123xyz";

const FULL_OFFER: PoolOfferFacts = {
  club: "FNF",
  places: 2,
  sport: "football",
  format: 7,
  kickoff: KICKOFF,
  durationMins: 60,
  venueName: "Goals North Cheam",
  address: "Cheam Common Rd, Worcester Park KT4 8RH",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=51.37,-0.23",
  distanceMiles: 1.8,
  playStyle: "casual",
  members: 30,
  gamesLast8Weeks: 8,
  fee: { kind: "amount", amount: "£6" },
};
/** The barest offer a live club can produce: every optional fact unknown. */
const BARE_OFFER: PoolOfferFacts = {
  ...FULL_OFFER,
  places: 1,
  format: null,
  address: null,
  mapUrl: null,
  distanceMiles: null,
  playStyle: null,
  members: 0,
  gamesLast8Weeks: 0,
  fee: null,
};

/** Every live shape of every template's job. */
const SHAPES: { [N in CloudTemplateName]: Array<CloudTemplateFacts[N]> } = {
  mt_code: [{ code: "482913" }, { code: "000117" }],
  mt_pool_offer: [
    { offer: FULL_OFFER, offerLink: OFFER_LINK, manageLink: MANAGE },
    { offer: BARE_OFFER, offerLink: OFFER_LINK, manageLink: MANAGE },
    { offer: { ...FULL_OFFER, fee: { kind: "free" }, playStyle: "competitive", gamesLast8Weeks: 3 }, offerLink: OFFER_LINK, manageLink: MANAGE },
    { offer: { ...FULL_OFFER, distanceMiles: 1, sport: "football", format: 11, playStyle: "mixed" }, offerLink: OFFER_LINK, manageLink: MANAGE },
  ],
  mt_pool_placed_in: [{ club: "FNF", kickoff: KICKOFF, venueName: "Goals North Cheam", offerLink: OFFER_LINK }],
  mt_pool_placed_in_fee: [{ club: "FNF", kickoff: KICKOFF, venueName: "Goals North Cheam", offerLink: OFFER_LINK, fee: "£6" }],
  mt_pool_placed_bench: [{ club: "FNF", kickoff: KICKOFF, venueName: "Goals North Cheam", offerLink: OFFER_LINK }],
  mt_pool_placed_bench_fee: [{ club: "FNF", kickoff: KICKOFF, venueName: "Goals North Cheam", offerLink: OFFER_LINK, fee: "£4.50" }],
  mt_pool_paused: [{ n: 3, manageLink: MANAGE }],
  mt_pool_paused_no_shows: [{ n: 2, games: 5, days: 14, manageLink: MANAGE }],
  mt_pool_paused_review: [{}],
  mt_pool_resumed: [{ manageLink: MANAGE }],
  mt_game_plan_changed: [{ club: "Sutton FC", kickoff: KICKOFF }],
  mt_taken_out: [{ club: "Sutton FC", kickoff: KICKOFF }],
  mt_place_given_back: [{ club: "Sutton FC", kickoff: KICKOFF, manageLink: MANAGE }],
  mt_pool_joined: [{ perWeek: 2, manageLink: MANAGE }],
  mt_pool_joined_early: [{ perWeek: 2, manageLink: MANAGE }],
  mt_pool_details_ask: [
    { days: [2], manageLink: MANAGE },
    { days: [6, 2, 0], manageLink: MANAGE },
  ],
  mt_club_invite_after_game: [{ club: "FNF", kickoff: KICKOFF, invitationsLink: INVITES }],
  mt_club_invite_organiser: [{ club: "FNF", invitationsLink: INVITES }],
  mt_club_invite_link: [{ club: "FNF", groupLink: GROUP }],
  mt_club_invite_closed: [{ club: "FNF" }],
};

const NAMES = CLOUD_TEMPLATES.map((t) => t.name);
const fill = <N extends CloudTemplateName>(name: N, lang: "en" | "tr", facts: CloudTemplateFacts[N]) => {
  const r = templateParams(name, lang, facts);
  if (!r.ok) throw new Error(`${name} ${lang}: ${r.reason}`);
  return r.params;
};

describe("the registry", () => {
  it("has one entry per name, each a Meta-legal name", () => {
    expect(new Set(NAMES).size).toBe(NAMES.length);
    for (const n of NAMES) expect(n).toMatch(/^mt_[a-z0-9_]+$/);
    expect([...NAMES].sort()).toEqual(Object.keys(SHAPES).sort());
  });

  it("each template has a Meta category and both languages", () => {
    for (const t of CLOUD_TEMPLATES) {
      expect(CLOUD_TEMPLATE_CATEGORIES).toContain(t.category);
      expect([...t.languages].sort()).toEqual(["en_GB", "tr"]);
    }
    expect(META_LANG).toEqual({ en: "en_GB", tr: "tr" });
  });

  it("every first contact purpose has at least one template, and every template serves one", () => {
    const served = new Set(CLOUD_TEMPLATES.flatMap((t) => t.purposes));
    expect(FIRST_CONTACT_PURPOSES.filter((p) => !served.has(p))).toEqual([]);
    for (const t of CLOUD_TEMPLATES) {
      expect(t.purposes.length).toBeGreaterThan(0);
      for (const p of t.purposes) expect(FIRST_CONTACT_PURPOSES as readonly string[]).toContain(p);
    }
  });

  it("the plan's categories (section 3.9, decision 1)", () => {
    expect(cloudTemplate("mt_code").category).toBe("AUTHENTICATION");
    expect(cloudTemplate("mt_pool_offer").category).toBe("UTILITY");
    expect(cloudTemplate("mt_pool_details_ask").category).toBe("UTILITY");
    expect(cloudTemplate("mt_club_invite_after_game").category).toBe("MARKETING");
    expect(cloudTemplate("mt_club_invite_organiser").category).toBe("MARKETING");
    expect(cloudTemplate("mt_club_invite_link").category).toBe("UTILITY");
    for (const t of CLOUD_TEMPLATES) if (t.name !== "mt_code") expect(t.category).not.toBe("AUTHENTICATION");
  });

  it("the body's variables are exactly the registry's variable list, in both languages", () => {
    for (const t of CLOUD_TEMPLATES) {
      for (const lang of ["en", "tr"] as const) {
        const body = templateBody(t.name, lang);
        if (t.category === "AUTHENTICATION") {
          expect(body).toBeNull();
          continue;
        }
        const used = [...new Set([...body!.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
        expect(used, `${t.name} ${lang}`).toEqual(t.vars.map((_, i) => i + 1));
      }
    }
  });

  it("at most two URL buttons, each with one variable at the very end of a fixed https base", () => {
    for (const t of CLOUD_TEMPLATES) {
      const urls = t.buttons.filter((b) => b.kind === "url");
      expect(urls.length).toBeLessThanOrEqual(2);
      for (const b of urls) expect(b.kind === "url" && b.url).toMatch(/^https:\/\/[a-z.]+\/[a-z/]*\{\{1\}\}$/);
    }
  });
});

describe("mt_code: Meta's fixed authentication text", () => {
  it("has no body of ours, the security line, a 10 minute expiry and a copy code button only", () => {
    const t = cloudTemplate("mt_code");
    expect(t.buttons).toEqual([{ kind: "copy_code", label: "copy_code" }]);
    expect(metaComponents("mt_code", "en")).toEqual([
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 10 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ]);
    expect(metaComponents("mt_code", "tr")[2]).toEqual({ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Kodu kopyala" }] });
  });

  it("sends the code as the body variable and the copy button's variable", () => {
    const params = fill("mt_code", "en", { code: "482913" });
    expect(params).toEqual({ body: ["482913"], buttons: [{ index: 0, text: "482913" }] });
    expect(templateMessage("mt_code", "tr", params)).toEqual({
      name: "mt_code",
      language: { code: "tr" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "482913" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
      ],
    });
  });

  it("refuses anything that is not a short run of digits", () => {
    expect(templateParams("mt_code", "en", { code: "12ab56" }).ok).toBe(false);
    expect(templateParams("mt_code", "en", { code: "" }).ok).toBe(false);
  });
});

describe("every variable is filled for every live shape", () => {
  for (const name of Object.keys(SHAPES) as CloudTemplateName[]) {
    for (const lang of ["en", "tr"] as const) {
      it(`${name} ${lang}`, () => {
        const t = cloudTemplate(name);
        for (const facts of SHAPES[name] as Array<CloudTemplateFacts[typeof name]>) {
          const params = fill(name, lang, facts as never);
          expect(params.body).toHaveLength(t.vars.length);
          for (const v of params.body) {
            expect(v.trim()).not.toBe("");
            // Meta refuses a variable with a new line, a tab or more than 4 spaces in a row.
            expect(v).not.toMatch(/[\n\t]| {5,}/);
          }
          const buttons = t.buttons.flatMap((b, i) => (b.kind === "quick_reply" ? [] : [i]));
          expect(params.buttons.map((b) => b.index)).toEqual(buttons);
          for (const b of params.buttons) expect(b.text).not.toMatch(/^https?:|\s/);
          if (t.category !== "AUTHENTICATION") expect(renderTemplatePreview(name, lang, params)).not.toMatch(/\{\{\d+\}\}/);
        }
      });
    }
  }
});

describe("what the filled templates say", () => {
  it("the offer, EN: every fact of the full offer, the tap and the settings suffixes", () => {
    const params = fill("mt_pool_offer", "en", SHAPES.mt_pool_offer[0]);
    expect(params.buttons).toEqual([
      { index: 0, text: "abc.def" },
      { index: 1, text: "x1Yz9" },
    ]);
    expect(renderTemplatePreview("mt_pool_offer", "en", params)).toBe(
      [
        "⚽ *FNF* needs 2 players for a 7-a-side football game on *Friday 30 October at 20:30*.",
        "📍 *Goals North Cheam*, Cheam Common Rd, Worcester Park KT4 8RH. 1.8 miles from you. Map: https://www.google.com/maps/search/?api=1&query=51.37,-0.23",
        "⏱️ 60 mins. Casual, friendly game. A regular group of 30 players, playing every week. 💷 £6 match fee",
        "",
        "You get this because you joined the MatchTime player pool. Would you like the place? Tap Answer, or reply here.",
      ].join("\n"),
    );
  });

  it("the offer, bare: the game's length still fills the details line", () => {
    const params = fill("mt_pool_offer", "en", SHAPES.mt_pool_offer[1]);
    expect(params.body).toEqual(["FNF", "1 player", "football game", "Friday 30 October at 20:30", "*Goals North Cheam*", "60 mins"]);
  });

  it("the offer, TR: Turkish facts, comma decimals", () => {
    const text = renderTemplatePreview("mt_pool_offer", "tr", fill("mt_pool_offer", "tr", SHAPES.mt_pool_offer[0]));
    expect(text).toContain("⚽ *FNF*, ");
    expect(text).toContain("2 oyuncu arıyor");
    expect(text).toContain("sana 1,8 mil");
    expect(text).toContain("⏱️ 60 dk. ");
    expect(text).toContain("Cevap'a dokun");
  });

  it("placed: the fee sentence only when there is an amount", () => {
    expect(placedTemplateName({ bench: false, fee: { kind: "amount", amount: "£6" } })).toBe("mt_pool_placed_in_fee");
    expect(placedTemplateName({ bench: false, fee: { kind: "free" } })).toBe("mt_pool_placed_in");
    expect(placedTemplateName({ bench: false, fee: null })).toBe("mt_pool_placed_in");
    expect(placedTemplateName({ bench: true, fee: { kind: "amount", amount: "£6" } })).toBe("mt_pool_placed_bench_fee");
    expect(placedTemplateName({ bench: true, fee: null })).toBe("mt_pool_placed_bench");
    expect(renderTemplatePreview("mt_pool_placed_in_fee", "en", fill("mt_pool_placed_in_fee", "en", SHAPES.mt_pool_placed_in_fee[0]))).toBe(
      "✅ You're in: *FNF*, Friday 30 October at 20:30, Goals North Cheam.\nThe match fee is £6. You'll get a pay link after the game.\nCan't make it after all? Tap below to give the place back.",
    );
  });

  it("joined: the early list has its own words", () => {
    expect(joinedTemplateName(false)).toBe("mt_pool_joined");
    expect(joinedTemplateName(true)).toBe("mt_pool_joined_early");
  });

  it("the details question names his days and the formats", () => {
    const params = fill("mt_pool_details_ask", "en", SHAPES.mt_pool_details_ask[1]);
    expect(params.body).toEqual(["Tuesday, Saturday and Sunday", "5, 7, 8, 9 or 11-a-side"]);
  });

  it("the group link button carries only the invite code", () => {
    expect(fill("mt_club_invite_link", "en", SHAPES.mt_club_invite_link[0]).buttons).toEqual([{ index: 0, text: "AbC123xyz" }]);
  });

  it("a link that is not the button's own kind is refused, never sent", () => {
    expect(templateParams("mt_club_invite_link", "en", { club: "FNF", groupLink: "https://evil.example/AbC" }).ok).toBe(false);
    expect(templateParams("mt_pool_paused", "en", { n: 3, manageLink: "https://matchtime.ai/play/manage" }).ok).toBe(false);
    expect(templateParams("mt_pool_offer", "en", { offer: FULL_OFFER, offerLink: "https://matchtime.ai/r/abc", manageLink: MANAGE }).ok).toBe(false);
  });

  it("a club name with a new line is refused (Meta would reject the send)", () => {
    expect(templateParams("mt_club_invite_closed", "en", { club: "FNF\nHQ" }).ok).toBe(false);
  });
});

describe("Meta's components for submission", () => {
  it("a utility template: body with examples, URL buttons with an example, quick replies", () => {
    const c = metaComponents("mt_pool_offer", "en");
    expect(c[0]).toMatchObject({ type: "BODY", text: templateBody("mt_pool_offer", "en") });
    const example = (c[0].example as { body_text: string[][] }).body_text[0];
    expect(example).toHaveLength(6);
    expect(c[1]).toEqual({
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Answer", url: "https://matchtime.ai/play/offer/{{1}}", example: [expect.stringMatching(/^https:\/\/matchtime\.ai\/play\/offer\/\S+$/)] },
        { type: "URL", text: "Settings", url: "https://matchtime.ai/r/{{1}}", example: [expect.stringMatching(/^https:\/\/matchtime\.ai\/r\/\S+$/)] },
        { type: "QUICK_REPLY", text: "Stop game offers" },
      ],
    });
  });

  it("a template with no variables and no buttons is a body alone", () => {
    expect(metaComponents("mt_pool_paused_review", "tr")).toEqual([{ type: "BODY", text: templateBody("mt_pool_paused_review", "tr") }]);
  });
});
