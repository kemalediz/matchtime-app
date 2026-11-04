/**
 * WHICH NUMBER EACH OUTGOING MESSAGE USES (WhatsApp Cloud API plan, PR C1;
 * MDs/whatsapp-cloud-api-plan-2026-11-04.md sections 5.1 and 5.8).
 *
 * `channelFor` is the one place that decides "baileys" (the club number on
 * the Pi) or "cloud" (the official number). Everything is off by default:
 * with no flags set, every message kind MatchTime sends today, and every
 * wa.me link it hands out, stays on the club number. That is proven here
 * for the whole current vocabulary, so a new purpose cannot slip through
 * unclassified.
 *
 * Pure functions. db is mocked only because the purpose lists are imported
 * from platform-jobs.ts (which imports db). No network, no model calls.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/pool/switch-env", () => ({ poolEnvForApiRequest: vi.fn() }));

import { OWNER_DM_PURPOSES, PLATFORM_DM_PURPOSES } from "../platform-jobs";
import {
  ANSWER_PURPOSES,
  CLUB_NUMBER_PURPOSES,
  FIRST_CONTACT_PURPOSES,
  WA_LINK_KINDS,
  channelFor,
  cloudApiEnabled,
  cloudPurposesFrom,
  fallbackWhenCloudDown,
  waLinkChannelFor,
  type SendChannel,
} from "../send-channel";
import { matchtimeWaNumber, waNumberFor } from "../club-connect";

const ALL_PURPOSES = [...PLATFORM_DM_PURPOSES, ...OWNER_DM_PURPOSES] as string[];
const REPLY_TO: Array<SendChannel | null | undefined> = [undefined, null, "baileys", "cloud"];
const BOTH_NUMBERS = { MATCHTIME_WA_NUMBER: "447700900555", WA_CLOUD_NUMBER: "447700900999" };

/** Environments in which the master switch is OFF, whatever else is set. */
const OFF_ENVS: Array<Record<string, string | undefined>> = [
  {},
  { ...BOTH_NUMBERS },
  { ...BOTH_NUMBERS, CLOUD_API_PURPOSES: ALL_PURPOSES.join(",") },
  { ...BOTH_NUMBERS, CLOUD_API_ENABLED: "", CLOUD_API_PURPOSES: ALL_PURPOSES.join(",") },
  { ...BOTH_NUMBERS, CLOUD_API_ENABLED: "0", CLOUD_API_PURPOSES: ALL_PURPOSES.join(",") },
  { ...BOTH_NUMBERS, CLOUD_API_ENABLED: "false", CLOUD_API_PURPOSES: ALL_PURPOSES.join(",") },
  { ...BOTH_NUMBERS, CLOUD_API_ENABLED: "off", CLOUD_API_PURPOSES: ALL_PURPOSES.join(",") },
  { ...BOTH_NUMBERS, CLOUD_API_ENABLED: "maybe", CLOUD_API_PURPOSES: ALL_PURPOSES.join(",") },
];

const on = (purposes: string[], extra: Record<string, string> = {}) => ({
  ...BOTH_NUMBERS,
  CLOUD_API_ENABLED: "1",
  CLOUD_API_PURPOSES: purposes.join(","),
  ...extra,
});

describe("the vocabulary covers every message kind sent today", () => {
  it("every platform and owner DM purpose is classified", () => {
    const classified = new Set<string>([...CLUB_NUMBER_PURPOSES, ...FIRST_CONTACT_PURPOSES, ...ANSWER_PURPOSES]);
    expect(ALL_PURPOSES.filter((p) => !classified.has(p))).toEqual([]);
  });

  it("nothing is classified that MatchTime does not send", () => {
    const known = new Set(ALL_PURPOSES);
    const classified = [...CLUB_NUMBER_PURPOSES, ...FIRST_CONTACT_PURPOSES, ...ANSWER_PURPOSES];
    expect(classified.filter((p) => !known.has(p))).toEqual([]);
  });

  it("a club number purpose is never also a first contact or an answer purpose", () => {
    const club = new Set<string>(CLUB_NUMBER_PURPOSES);
    expect([...FIRST_CONTACT_PURPOSES, ...ANSWER_PURPOSES].filter((p) => club.has(p))).toEqual([]);
  });

  it("every owner DM stays on the club number (the doorbell to Kemal never moves)", () => {
    for (const p of OWNER_DM_PURPOSES) expect(CLUB_NUMBER_PURPOSES as readonly string[]).toContain(p);
  });

  it("the decided stays (section 6): partner pool invite and every setup and billing DM", () => {
    for (const p of [
      "pool-partner-invite",
      "connect-reply",
      "organiser-decision",
      "billing",
      "setup-learned",
      "setup-ask",
      "setup-admin-code",
      "setup-reminder",
      "setup-removed",
      "setup-owner-live",
    ]) {
      expect(CLUB_NUMBER_PURPOSES as readonly string[]).toContain(p);
    }
  });
});

describe("flags off: every message kind stays on the club number", () => {
  it("cloudApiEnabled is off unless the master flag is explicitly on", () => {
    for (const env of OFF_ENVS) expect(cloudApiEnabled(env)).toBe(false);
    for (const v of ["1", "true", "on", "yes", "TRUE", " 1 "]) expect(cloudApiEnabled({ CLOUD_API_ENABLED: v })).toBe(true);
  });

  it("channelFor answers baileys for every purpose, every replyTo, every off environment", () => {
    const offenders: string[] = [];
    for (const env of OFF_ENVS) {
      for (const purpose of ALL_PURPOSES) {
        for (const replyTo of REPLY_TO) {
          const got = channelFor({ purpose, replyTo, env });
          if (got !== "baileys") offenders.push(`${purpose} replyTo=${replyTo} env=${JSON.stringify(env)} -> ${got}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every wa.me link kind uses the club number, the same digits as matchtimeWaNumber()", () => {
    for (const env of OFF_ENVS) {
      for (const kind of WA_LINK_KINDS) {
        expect(waLinkChannelFor(kind, env)).toBe("baileys");
        expect(waNumberFor(waLinkChannelFor(kind, env), env)).toBe(matchtimeWaNumber(env));
      }
    }
  });

  it("the master flag on with no purposes listed still moves nothing that starts a conversation", () => {
    const env = on([]);
    for (const purpose of ALL_PURPOSES) expect(channelFor({ purpose, env })).toBe("baileys");
    for (const kind of WA_LINK_KINDS) expect(waLinkChannelFor(kind, env)).toBe("baileys");
  });
});

describe("flags on: one flow at a time", () => {
  it("a listed first contact purpose goes to the official number; an unlisted one does not", () => {
    const env = on(["otp"]);
    expect(channelFor({ purpose: "otp", env })).toBe("cloud");
    expect(channelFor({ purpose: "pool-offer", env })).toBe("baileys");
  });

  it("every first contact purpose moves when listed", () => {
    for (const p of FIRST_CONTACT_PURPOSES) expect(channelFor({ purpose: p, env: on([p]) })).toBe("cloud");
  });

  it("listing a club number purpose has no effect", () => {
    const env = on([...CLUB_NUMBER_PURPOSES]);
    for (const p of CLUB_NUMBER_PURPOSES) {
      for (const replyTo of REPLY_TO) expect(channelFor({ purpose: p, replyTo, env })).toBe("baileys");
    }
  });

  it("an unknown purpose stays on the club number", () => {
    expect(channelFor({ purpose: "something-new", env: on(["something-new"]) })).toBe("baileys");
  });

  it("the list is trimmed, ignores empties and unknown or club-only names", () => {
    expect([...cloudPurposesFrom({ CLOUD_API_PURPOSES: " otp , ,pool-offer,billing,nope," })].sort()).toEqual(["otp", "pool-offer"]);
    expect([...cloudPurposesFrom({})]).toEqual([]);
  });

  it("a business initiated purpose goes to the official number even if he last wrote to the club number", () => {
    // Pool things come from the official number (plan 5.4); the dispatcher
    // later picks free form or template from the window.
    expect(channelFor({ purpose: "pool-placed", replyTo: "baileys", env: on(["pool-placed"]) })).toBe("cloud");
  });
});

describe("answers go back where he wrote (plan 5.1)", () => {
  it("an answer purpose follows replyTo once the master flag is on, listed or not", () => {
    const env = on([]);
    for (const p of ANSWER_PURPOSES) {
      expect(channelFor({ purpose: p, replyTo: "cloud", env })).toBe("cloud");
      expect(channelFor({ purpose: p, replyTo: "baileys", env: on([...FIRST_CONTACT_PURPOSES]) })).toBe("baileys");
    }
  });

  it("an answer purpose with no replyTo stays on the club number, unless it is also a first contact purpose that is listed", () => {
    const env = on([...FIRST_CONTACT_PURPOSES]);
    for (const p of ANSWER_PURPOSES) {
      const expected = (FIRST_CONTACT_PURPOSES as readonly string[]).includes(p) ? "cloud" : "baileys";
      expect(channelFor({ purpose: p, env })).toBe(expected);
    }
  });

  it("the pool welcome is both: an answer when he wrote, the joined message when he joined on the web", () => {
    const env = on(["pool-welcome"]);
    expect(channelFor({ purpose: "pool-welcome", replyTo: "baileys", env })).toBe("baileys");
    expect(channelFor({ purpose: "pool-welcome", replyTo: "cloud", env })).toBe("cloud");
    expect(channelFor({ purpose: "pool-welcome", env })).toBe("cloud");
  });

  it("a replyTo that is not a channel is ignored", () => {
    const env = on([]);
    expect(channelFor({ purpose: "pool-reply", replyTo: "sms" as unknown as SendChannel, env })).toBe("baileys");
  });
});

describe("wa.me links: the pool's door moves with the pool welcome; the club doors never move", () => {
  it("pool sign-up, friend sign-up and the member pool step follow pool-welcome", () => {
    const env = on(["pool-welcome"]);
    expect(waLinkChannelFor("pool-signup", env)).toBe("cloud");
    expect(waLinkChannelFor("friend-signup", env)).toBe("cloud");
    expect(waLinkChannelFor("member-pool-join", env)).toBe("cloud");
    expect(waNumberFor(waLinkChannelFor("pool-signup", env), env)).toBe("447700900999");
  });

  it("self-join connect and partner asks keep the club number whatever is listed (decided)", () => {
    const env = on([...FIRST_CONTACT_PURPOSES]);
    expect(waLinkChannelFor("club-connect", env)).toBe("baileys");
    expect(waLinkChannelFor("partner-ask", env)).toBe("baileys");
    expect(waNumberFor(waLinkChannelFor("partner-ask", env), env)).toBe("447700900555");
  });
});

describe("waNumberFor: digits only, server only, no silent fallback", () => {
  it("baileys reads MATCHTIME_WA_NUMBER, cloud reads WA_CLOUD_NUMBER", () => {
    expect(waNumberFor("baileys", { MATCHTIME_WA_NUMBER: "+44 7700 900555", WA_CLOUD_NUMBER: "447700900999" })).toBe("447700900555");
    expect(waNumberFor("cloud", { MATCHTIME_WA_NUMBER: "447700900555", WA_CLOUD_NUMBER: "+44 7700 900999" })).toBe("447700900999");
  });

  it("an unset or invalid official number is null, never the club number (strangers never fall back)", () => {
    expect(waNumberFor("cloud", { MATCHTIME_WA_NUMBER: "447700900555" })).toBeNull();
    expect(waNumberFor("cloud", { MATCHTIME_WA_NUMBER: "447700900555", WA_CLOUD_NUMBER: "12345" })).toBeNull();
  });

  it("a NEXT_PUBLIC_ variant is never read", () => {
    expect(waNumberFor("cloud", { NEXT_PUBLIC_WA_CLOUD_NUMBER: "447700900999" })).toBeNull();
  });
});

describe("when the official number is down (decided: codes only fall back)", () => {
  it("a code falls back to the club number", () => {
    expect(fallbackWhenCloudDown("otp")).toBe("baileys");
  });

  it("nothing else falls back: strangers never land on the club number", () => {
    for (const p of ALL_PURPOSES.filter((x) => x !== "otp")) expect(fallbackWhenCloudDown(p)).toBeNull();
  });
});
