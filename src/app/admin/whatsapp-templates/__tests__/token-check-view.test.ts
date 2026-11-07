/**
 * The owner page's "Access token check", rendered to HTML: Meta's facts
 * about the token, whether it can see the official number, and which
 * settings are present (length only). Built from a `TokenCheck`, which never
 * carries a secret; these pin that every field reaches the page.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TokenCheck } from "@/lib/cloud-api/token-check";
import { TokenCheckView } from "../token-check-view";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

const OK: TokenCheck = {
  graphVersion: "v26.0",
  token: { outerWhitespace: false, newline: true },
  env: [
    { name: "WA_CLOUD_ACCESS_TOKEN", present: true, length: 212, outerWhitespace: false },
    { name: "WA_CLOUD_APP_ID", present: false, length: 0, outerWhitespace: false },
  ],
  debug: {
    state: "ok",
    info: {
      isValid: true,
      appId: "3717715315059721",
      type: "SYSTEM_USER",
      application: "MatchTime",
      expiresAt: 0,
      dataAccessExpiresAt: 1770000000,
      issuedAt: 1762300000,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      granularScopes: [
        { scope: "whatsapp_business_management", targetIds: ["999888777"] },
        { scope: "whatsapp_business_messaging", targetIds: null },
      ],
      userId: "122100000000000001",
      error: { code: 190, subcode: 460, message: "Password changed" },
      wabaInTargets: false,
    },
  },
  phone: { state: "error", message: "HTTP 400 100: Unsupported get request." },
  probes: [
    {
      id: "waba-templates",
      label: "The account's templates",
      version: "v27.0",
      path: "/1566680795216924/message_templates?limit=1&fields=name,status",
      outcome: {
        state: "error",
        error: {
          status: 400,
          code: 100,
          subcode: 33,
          type: "GraphMethodException",
          fbtraceId: "AbCdEf123",
          message: "Unsupported get request. Object with ID '1566680795216924' does not exist",
        },
      },
    },
    {
      id: "me",
      label: "The token's user",
      version: "v26.0",
      path: "/me?fields=id,name",
      outcome: { state: "ok", status: 200, result: '{"id":"122100000000000001","name":"MatchTime System User"}' },
    },
    {
      id: "waba-subscribed-apps",
      label: "Apps subscribed to the account",
      version: "v26.0",
      path: "/1566680795216924/subscribed_apps",
      outcome: { state: "ok", status: 200, result: '{"data":[]}', note: "WA_CLOUD_APP_ID subscribed: no" },
    },
    {
      id: "phone-waba",
      label: "The number's account",
      version: "v26.0",
      path: "/555000111?fields=id,whatsapp_business_account",
      outcome: { state: "skipped", reason: "WA_CLOUD_PHONE_NUMBER_ID is not set" },
    },
  ],
};

describe("TokenCheckView", () => {
  it("shows every non-secret fact Meta gave about the token", () => {
    const t = text(renderToStaticMarkup(createElement(TokenCheckView, { check: OK })));
    expect(t).toContain("v26.0");
    expect(t).toMatch(/is_valid\s+yes/);
    expect(t).toContain("3717715315059721");
    expect(t).toContain("SYSTEM_USER");
    expect(t).toContain("MatchTime");
    expect(t).toMatch(/expires_at\s+never \(0\)/);
    expect(t).toMatch(/data_access_expires_at\s+1770000000/);
    expect(t).toContain("whatsapp_business_management, whatsapp_business_messaging");
    expect(t).toContain("999888777");
    expect(t).toMatch(/all targets/);
    expect(t).toContain("122100000000000001");
    expect(t).toContain("190");
    expect(t).toContain("Password changed");
    expect(t).toMatch(/WA_CLOUD_WABA_ID among the targets\s+no/);
  });

  it("shows the number's error and the settings as present or missing with length", () => {
    const t = text(renderToStaticMarkup(createElement(TokenCheckView, { check: OK })));
    expect(t).toContain("Unsupported get request.");
    expect(t).toMatch(/WA_CLOUD_ACCESS_TOKEN\s+yes\s+212/);
    expect(t).toMatch(/WA_CLOUD_APP_ID\s+no\s+0/);
    expect(t).toMatch(/newline\s+yes/);
    expect(t).toMatch(/leading or trailing whitespace\s+no/);
  });

  it("shows the number when the token can see it, and a skipped check's reason", () => {
    const check: TokenCheck = {
      ...OK,
      debug: { state: "skipped", reason: "WA_CLOUD_APP_ID is not set" },
      phone: { state: "ok", id: "555000111", displayPhoneNumber: "+44 7700 900000", verifiedName: "MatchTime" },
    };
    const t = text(renderToStaticMarkup(createElement(TokenCheckView, { check })));
    expect(t).toContain("WA_CLOUD_APP_ID is not set");
    expect(t).toContain("555000111");
    expect(t).toContain("+44 7700 900000");
  });

  it("shows debug_token's own failure", () => {
    const check: TokenCheck = { ...OK, debug: { state: "error", message: "HTTP 400 190: Invalid OAuth access token signature." } };
    const t = text(renderToStaticMarkup(createElement(TokenCheckView, { check })));
    expect(t).toContain("Invalid OAuth access token signature.");
  });

  it("shows each probe in one table: probe, version, ok or error, and Meta's error fields or the answer", () => {
    const html = renderToStaticMarkup(createElement(TokenCheckView, { check: OK }));
    const t = text(html);
    expect(html).toContain('data-testid="wt-token-probes"');
    expect(t).toMatch(/Probe\s+Version\s+Outcome\s+Result or Meta's error/);
    expect(t).toMatch(/The account's templates \/1566680795216924\/message_templates\?limit=1&fields=name,status\s+v27\.0\s+error/);
    expect(t).toContain("HTTP 400");
    expect(t).toContain("code 100");
    expect(t).toContain("subcode 33");
    expect(t).toContain("type GraphMethodException");
    expect(t).toContain("fbtrace_id AbCdEf123");
    expect(t).toContain("Object with ID '1566680795216924' does not exist");
    expect(t).toMatch(/The token's user \/me\?fields=id,name\s+v26\.0\s+ok/);
    expect(t).toContain('{"id":"122100000000000001","name":"MatchTime System User"}');
    expect(t).toContain("WA_CLOUD_APP_ID subscribed: no");
    expect(t).toMatch(/v26\.0\s+skipped\s+WA_CLOUD_PHONE_NUMBER_ID is not set/);
  });
});
