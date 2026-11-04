/**
 * POST /api/play/signup with the SHORT /play form (2026-11-04): name,
 * postcode area and days, plus the two ticks. The route fills in the short
 * form's defaults (3 miles, any hour of each day, football in any format,
 * no level) before the one validator, and still refuses an unticked 18+
 * or consent. The full payload (partner invite, scenarios) still works.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const signup = vi.hoisted(() => ({ createPoolSignup: vi.fn() }));
vi.mock("@/lib/pool/signup", () => signup);
vi.mock("@/lib/pool/flags", () => ({ isPoolSignupPaused: () => false }));
vi.mock("@/lib/pool/flags-request", () => ({ poolOpenForApiRequest: async () => false }));
vi.mock("@/lib/club-connect", () => ({ matchtimeWaNumber: () => "447700900555" }));
vi.mock("@/lib/pool/request-ip", () => ({ poolRequestIp: () => "203.0.113.9" }));
vi.mock("@/lib/pool/signup-status-token", () => ({ poolSignupStatusToken: () => "tok" }));
vi.mock("@/lib/friend-link/page", () => ({ openFriendLink: async () => null }));

import { POST } from "../route";

const post = (body: unknown) => POST(new Request("http://x/api/play/signup", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const SHORT = { name: "Ali K", area: { kind: "district", district: "sm1" }, days: [2, 6], adult: true, consent: true, source: {} };

beforeEach(() => {
  vi.clearAllMocks();
  signup.createPoolSignup.mockResolvedValue({ ok: true, id: "p1", code: "ABCDE", expiresAt: new Date("2026-11-07T12:00:00Z"), earlyList: true });
});

describe("the short form", () => {
  it("is signed up with the defaults: 3 miles, each day whole, football any format, no level", async () => {
    const res = await post(SHORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "ABCDE", waLink: expect.stringContaining("wa.me/447700900555") });
    const fields = signup.createPoolSignup.mock.calls[0][0].fields;
    expect(fields).toEqual({
      displayName: "Ali K",
      areaDistrict: "SM1",
      maxMiles: 3,
      availability: [
        { day: 2, fromMin: 0, toMin: 1440 },
        { day: 6, fromMin: 0, toMin: 1440 },
      ],
      sports: [{ sport: "football", otherName: "", formats: [], level: null, levelText: null }],
      language: "en",
    });
  });

  it("names a missing day, and both legal ticks, and writes nothing", async () => {
    const res = await post({ ...SHORT, days: [], adult: false, consent: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: "invalid", errors: { availability: "none", adult: "required", consent: "required" } });
    expect(signup.createPoolSignup).not.toHaveBeenCalled();
  });

  it("a full payload is still read as it was", async () => {
    const res = await post({
      name: "Sam S",
      area: { kind: "district", district: "SM1" },
      maxMiles: 5,
      availability: [{ day: 2, from: "19:00", to: "22:00" }],
      sports: [{ sport: "football", formats: [7] }],
      adult: true,
      consent: true,
    });
    expect(res.status).toBe(200);
    expect(signup.createPoolSignup.mock.calls[0][0].fields).toMatchObject({ maxMiles: 5, availability: [{ day: 2, fromMin: 1140, toMin: 1320 }] });
  });
});
