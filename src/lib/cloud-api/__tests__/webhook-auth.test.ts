/**
 * THE WEBHOOK'S TWO LOCKS (WhatsApp Cloud API plan, PR C5, sections 1 and
 * 5.2): Meta's GET handshake, answered only for our verify token, and the
 * `X-Hub-Signature-256` on every POST, an HMAC SHA256 of the RAW body
 * keyed with the app secret. Both compared in constant time.
 */
import { describe, expect, it } from "vitest";
import { signWebhook } from "../../../../e2e/stubs/cloud-api";
import { handshakeChallenge, validMetaSignature } from "../webhook-auth";

const TOKEN = "a-long-random-verify-token";
const SECRET = "app-secret";

const params = (p: Record<string, string>) => new URLSearchParams(p);

describe("handshakeChallenge (GET)", () => {
  it("answers the challenge for hub.mode=subscribe and our verify token", () => {
    expect(handshakeChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1158201444" }), TOKEN)).toBe("1158201444");
  });

  it("refuses a wrong token, a token that is only a prefix, and one with extra characters", () => {
    for (const t of ["nope", TOKEN.slice(0, -1), `${TOKEN}x`, ""]) {
      expect(handshakeChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": t, "hub.challenge": "1" }), TOKEN)).toBeNull();
    }
  });

  it("refuses any mode other than subscribe, and a missing challenge", () => {
    expect(handshakeChallenge(params({ "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "1" }), TOKEN)).toBeNull();
    expect(handshakeChallenge(params({ "hub.verify_token": TOKEN, "hub.challenge": "1" }), TOKEN)).toBeNull();
    expect(handshakeChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": TOKEN }), TOKEN)).toBeNull();
  });

  it("refuses everything while WA_CLOUD_VERIFY_TOKEN is unset or blank", () => {
    expect(handshakeChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), undefined)).toBeNull();
    expect(handshakeChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "  ", "hub.challenge": "1" }), "  ")).toBeNull();
  });
});

describe("validMetaSignature (POST)", () => {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [] }] });

  it("accepts Meta's signature of the raw body (string or bytes)", () => {
    expect(validMetaSignature(raw, signWebhook(raw, SECRET), SECRET)).toBe(true);
    expect(validMetaSignature(Buffer.from(raw, "utf8"), signWebhook(raw, SECRET), SECRET)).toBe(true);
  });

  it("accepts the hex in upper case too", () => {
    const sig = signWebhook(raw, SECRET);
    expect(validMetaSignature(raw, `sha256=${sig.slice(7).toUpperCase()}`, SECRET)).toBe(true);
  });

  it("refuses a missing, malformed or wrong signature", () => {
    expect(validMetaSignature(raw, null, SECRET)).toBe(false);
    expect(validMetaSignature(raw, "", SECRET)).toBe(false);
    expect(validMetaSignature(raw, "sha256=", SECRET)).toBe(false);
    expect(validMetaSignature(raw, "sha256=zz", SECRET)).toBe(false);
    // No "sha256=" prefix, the wrong algorithm, the wrong key.
    expect(validMetaSignature(raw, signWebhook(raw, SECRET).slice(7), SECRET)).toBe(false);
    expect(validMetaSignature(raw, `sha1=${signWebhook(raw, SECRET).slice(7)}`, SECRET)).toBe(false);
    expect(validMetaSignature(raw, signWebhook(raw, "another-secret"), SECRET)).toBe(false);
  });

  it("refuses a tampered body, even by one character", () => {
    const sig = signWebhook(raw, SECRET);
    expect(validMetaSignature(raw.replace('"1"', '"2"'), sig, SECRET)).toBe(false);
    expect(validMetaSignature(`${raw} `, sig, SECRET)).toBe(false);
  });

  it("refuses everything while WA_CLOUD_APP_SECRET is unset or blank", () => {
    expect(validMetaSignature(raw, signWebhook(raw, ""), undefined)).toBe(false);
    expect(validMetaSignature(raw, signWebhook(raw, ""), "")).toBe(false);
  });

  it("checks the bytes Meta signed: a non-ASCII body is signed as UTF-8", () => {
    const tr = JSON.stringify({ text: "Yerin hazır, teşekkürler" });
    expect(validMetaSignature(Buffer.from(tr, "utf8"), signWebhook(tr, SECRET), SECRET)).toBe(true);
  });
});
