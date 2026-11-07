/**
 * THE CLOUD WEBHOOK PARSER (WhatsApp Cloud API plan, PR C5, sections 1,
 * 5.2 and 5.4). Pure: Meta's payload in, what arrived out. The fixtures
 * follow Meta's own examples (webhooks reference: messages, status,
 * user_preferences; business scoped user ids), read 7 Nov 2026.
 */
import { describe, expect, it } from "vitest";
import { inboundDmOf, parseCloudWebhook, type CloudInboundMessage } from "../inbound";

const META = { display_phone_number: "447700900000", phone_number_id: "106540352242922" };

function payload(...changes: Array<{ field: string; value: Record<string, unknown> }>): unknown {
  return { object: "whatsapp_business_account", entry: [{ id: "102290129340398", changes }] };
}
const messages = (value: Record<string, unknown>) => ({ field: "messages", value: { messaging_product: "whatsapp", metadata: META, ...value } });

// Meta's text example (business scoped user ids page), with a phone.
const TEXT = messages({
  contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234", user_id: "US.13491208655302741918" }],
  messages: [
    {
      from: "16505551234",
      from_user_id: "US.13491208655302741918",
      id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
      timestamp: "1749416383",
      type: "text",
      text: { body: "Does it come in another color?" },
    },
  ],
});

// Meta's username example: no phone anywhere, the user id only.
const USERNAME_ONLY = messages({
  contacts: [{ profile: { name: "Sheena Nelson", username: "realsheenanelson" }, user_id: "US.13491208655302741918", parent_user_id: "US.ENT.11815799212886844830" }],
  messages: [
    {
      from_user_id: "US.13491208655302741918",
      from_parent_user_id: "US.ENT.11815799212886844830",
      id: "wamid.USERNAME1",
      timestamp: "1749416390",
      type: "text",
      text: { body: "hello" },
    },
  ],
});

describe("parseCloudWebhook: messages", () => {
  it("reads Meta's text message: wamid, phone, user id, name, timestamp and text", () => {
    const out = parseCloudWebhook(payload(TEXT));
    expect(out.messages).toEqual<CloudInboundMessage[]>([
      {
        wamid: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
        phoneNumberId: "106540352242922",
        phone: "16505551234",
        waUserId: "US.13491208655302741918",
        type: "text",
        text: "Does it come in another color?",
        senderName: "Sheena Nelson",
        timestamp: "1749416383",
        quotedId: null,
        quotedFromUs: null,
      },
    ]);
    expect(out.statuses).toEqual([]);
  });

  it("a username with no phone is kept by its business scoped user id (plan 5.4)", () => {
    const [m] = parseCloudWebhook(payload(USERNAME_ONLY)).messages;
    expect(m).toMatchObject({ wamid: "wamid.USERNAME1", phone: null, waUserId: "US.13491208655302741918", senderName: "Sheena Nelson", text: "hello" });
  });

  it("a template quick reply button arrives as its text, with the quoted message", () => {
    const [m] = parseCloudWebhook(
      payload(
        messages({
          contacts: [{ profile: { name: "Sam" }, wa_id: "447700900001" }],
          messages: [
            {
              context: { from: "447700900000", id: "wamid.OFFER1" },
              from: "447700900001",
              id: "wamid.BTN1",
              timestamp: "1762500000",
              type: "button",
              button: { payload: "stop-offers", text: "Stop game offers" },
            },
          ],
        }),
      ),
    ).messages;
    expect(m).toMatchObject({ type: "button", text: "Stop game offers", quotedId: "wamid.OFFER1", quotedFromUs: true });
  });

  it("an interactive reply (button or list) arrives as its title", () => {
    const out = parseCloudWebhook(
      payload(
        messages({
          messages: [
            { from: "447700900001", id: "wamid.I1", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes please" } } },
            { from: "447700900001", id: "wamid.I2", timestamp: "2", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "x", title: "Thursdays", description: "after 6" } } },
          ],
        }),
      ),
    );
    expect(out.messages.map((m) => m.text)).toEqual(["Yes please", "Thursdays"]);
  });

  it("a quote of his own message is not MatchTime's", () => {
    const [m] = parseCloudWebhook(
      payload(messages({ messages: [{ context: { from: "447700900001", id: "wamid.HIS" }, from: "447700900001", id: "wamid.Q", timestamp: "1", type: "text", text: { body: "this" } }] })),
    ).messages;
    expect(m).toMatchObject({ quotedId: "wamid.HIS", quotedFromUs: false });
  });

  it("a media caption is the text, as the Pi forwards it; media without one, a reaction, unsupported: no text, still recorded", () => {
    const out = parseCloudWebhook(
      payload(
        messages({
          messages: [
            { from: "447700900001", id: "wamid.IMG1", timestamp: "1", type: "image", image: { caption: "my boots", mime_type: "image/jpeg", id: "m1" } },
            { from: "447700900001", id: "wamid.IMG2", timestamp: "2", type: "image", image: { mime_type: "image/jpeg", id: "m2" } },
            { from: "447700900001", id: "wamid.R1", timestamp: "3", type: "reaction", reaction: { message_id: "wamid.OFFER1", emoji: "👍" } },
            { from: "447700900001", id: "wamid.U1", timestamp: "4", type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] },
          ],
        }),
      ),
    );
    expect(out.messages.map((m) => [m.wamid, m.type, m.text])).toEqual([
      ["wamid.IMG1", "image", "my boots"],
      ["wamid.IMG2", "image", null],
      ["wamid.R1", "reaction", null],
      ["wamid.U1", "unsupported", null],
    ]);
  });

  it("the sender name comes from the contact that matches him, not another one", () => {
    const [a, b] = parseCloudWebhook(
      payload(
        messages({
          contacts: [
            { profile: { name: "Ali" }, wa_id: "905321112233" },
            { profile: { name: "Sam" }, wa_id: "447700900001" },
          ],
          messages: [
            { from: "447700900001", id: "wamid.A", timestamp: "1", type: "text", text: { body: "a" } },
            { from: "905321112233", id: "wamid.B", timestamp: "1", type: "text", text: { body: "b" } },
          ],
        }),
      ),
    ).messages;
    expect([a.senderName, b.senderName]).toEqual(["Sam", "Ali"]);
  });

  it("the same wamid twice in one POST is one message", () => {
    const m = { from: "447700900001", id: "wamid.DUP", timestamp: "1", type: "text", text: { body: "IN" } };
    expect(parseCloudWebhook(payload(messages({ messages: [m, m] }), messages({ messages: [m] }))).messages).toHaveLength(1);
  });

  it("a sender we cannot name (no valid phone, no user id) or a message with no id is skipped and counted", () => {
    const out = parseCloudWebhook(
      payload(
        messages({
          messages: [
            { from: "+44 7700", id: "wamid.BAD1", timestamp: "1", type: "text", text: { body: "x" } },
            { from: "447700900001", timestamp: "1", type: "text", text: { body: "no id" } },
            { from: "not-a-phone", from_user_id: "GB.1", id: "wamid.OK", timestamp: "1", type: "text", text: { body: "y" } },
          ],
        }),
      ),
    );
    expect(out.messages.map((m) => [m.wamid, m.phone, m.waUserId])).toEqual([["wamid.OK", null, "GB.1"]]);
    expect(out.skipped).toBe(2);
  });

  it("a blank text is no text", () => {
    const [m] = parseCloudWebhook(payload(messages({ messages: [{ from: "447700900001", id: "wamid.B", timestamp: "1", type: "text", text: { body: "   " } }] }))).messages;
    expect(m.text).toBeNull();
  });
});

describe("parseCloudWebhook: statuses", () => {
  const status = (s: Record<string, unknown>) => messages({ statuses: [s] });

  it("reads sent with Meta's pricing, and the job id we set in biz_opaque_callback_data", () => {
    const out = parseCloudWebhook(
      payload(
        status({
          id: "wamid.SENT1",
          status: "sent",
          timestamp: "1750030073",
          recipient_id: "447700900001",
          recipient_user_id: "GB.42",
          biz_opaque_callback_data: "job_123",
          conversation: { id: "c1", expiration_timestamp: "1750116473", origin: { type: "utility" } },
          pricing: { billable: true, pricing_model: "PMP", type: "regular", category: "utility" },
        }),
      ),
    );
    expect(out.statuses).toEqual([
      {
        wamid: "wamid.SENT1",
        phoneNumberId: "106540352242922",
        status: "sent",
        at: new Date(1750030073 * 1000),
        recipient: "447700900001",
        recipientUserId: "GB.42",
        jobId: "job_123",
        errorCode: null,
        errorTitle: null,
        pricing: { category: "utility", billable: true, model: "PMP", type: "regular" },
      },
    ]);
  });

  it("reads delivered and read; a username's delivered status has his user id and no phone", () => {
    const out = parseCloudWebhook(
      payload(
        messages({
          statuses: [
            { id: "wamid.D1", status: "delivered", timestamp: "1750030080", recipient_user_id: "US.134" },
            { id: "wamid.D1", status: "read", timestamp: "1750030090", recipient_id: "16505551234" },
          ],
        }),
      ),
    );
    expect(out.statuses.map((s) => [s.status, s.recipient, s.recipientUserId, s.pricing])).toEqual([
      ["delivered", null, "US.134", null],
      ["read", "16505551234", null, null],
    ]);
  });

  it("reads failed with Meta's first error code and title (Meta's 131049 example)", () => {
    const [s] = parseCloudWebhook(
      payload(
        status({
          id: "wamid.F1",
          status: "failed",
          timestamp: "1750030100",
          recipient_id: "447700900001",
          errors: [
            {
              code: 131049,
              title: "This message was not delivered to maintain healthy ecosystem engagement.",
              message: "This message was not delivered to maintain healthy ecosystem engagement.",
              error_data: { details: "In order to maintain a healthy ecosystem engagement, the message failed to be delivered." },
              href: "/documentation/business-messaging/whatsapp/support/error-codes",
            },
          ],
        }),
      ),
    ).statuses;
    expect(s).toMatchObject({ status: "failed", errorCode: 131049, errorTitle: "This message was not delivered to maintain healthy ecosystem engagement." });
  });

  it("the same status for the same wamid twice in one POST is one; a bad timestamp is null", () => {
    const s = { id: "wamid.X", status: "delivered", timestamp: "soon", recipient_id: "447700900001" };
    const out = parseCloudWebhook(payload(messages({ statuses: [s, s] })));
    expect(out.statuses).toHaveLength(1);
    expect(out.statuses[0].at).toBeNull();
  });

  it("a status with no id or no status is skipped", () => {
    const out = parseCloudWebhook(payload(messages({ statuses: [{ status: "sent" }, { id: "wamid.Y" }] })));
    expect(out.statuses).toEqual([]);
    expect(out.skipped).toBe(2);
  });
});

describe("parseCloudWebhook: the other fields", () => {
  it("counts template status and category updates (C6 writes them from the whole payload)", () => {
    const out = parseCloudWebhook(
      payload(
        { field: "message_template_status_update", value: { event: "APPROVED", message_template_id: 1, message_template_name: "mt_code", message_template_language: "en_GB", reason: "NONE" } },
        { field: "template_category_update", value: { message_template_id: 1, message_template_name: "mt_pool_offer", message_template_language: "en_GB", previous_category: "UTILITY", new_category: "MARKETING" } },
      ),
    );
    expect(out.templateUpdates).toBe(2);
    expect(out.messages).toEqual([]);
  });

  it("reads Meta's user_preferences (he stopped or resumed marketing messages)", () => {
    const out = parseCloudWebhook(
      payload({
        field: "user_preferences",
        value: {
          messaging_product: "whatsapp",
          metadata: META,
          contacts: [{ wa_id: "447700900001", user_id: "GB.42" }],
          user_preferences: [
            { wa_id: "447700900001", user_id: "GB.42", detail: "User requested to stop marketing messages", category: "marketing_messages", value: "stop", timestamp: 1762500000 },
            { user_id: "GB.43", detail: "User requested to resume marketing messages", category: "marketing_messages", value: "resume", timestamp: 1762500001 },
          ],
        },
      }),
    );
    expect(out.preferences).toEqual([
      { phone: "447700900001", waUserId: "GB.42", category: "marketing_messages", value: "stop", at: new Date(1762500000 * 1000) },
      { phone: null, waUserId: "GB.43", category: "marketing_messages", value: "resume", at: new Date(1762500001 * 1000) },
    ]);
  });

  it("names the other fields it saw, for the log (quality, account updates)", () => {
    const out = parseCloudWebhook(payload({ field: "phone_number_quality_update", value: { event: "FLAGGED" } }, { field: "account_update", value: {} }));
    expect(out.otherFields).toEqual(["phone_number_quality_update", "account_update"]);
  });

  it("anything that is not Meta's shape is nothing, never a throw", () => {
    for (const p of [null, "x", 1, [], {}, { entry: "x" }, { entry: [{ changes: [null, { field: "messages" }, { field: "messages", value: { messages: "x" } }] }] }]) {
      expect(() => parseCloudWebhook(p)).not.toThrow();
      expect(parseCloudWebhook(p).messages).toEqual([]);
    }
  });
});

describe("inboundDmOf: the one DM pipeline's input (plan 5.3)", () => {
  const base: CloudInboundMessage = {
    wamid: "wamid.T1",
    phoneNumberId: "1",
    phone: "447700900001",
    waUserId: "GB.42",
    type: "text",
    text: "IN",
    senderName: "Sam",
    timestamp: "1762500000",
    quotedId: null,
    quotedFromUs: null,
  };

  it("is the same shape the Pi posts to dm-reply", () => {
    expect(inboundDmOf(base)).toEqual({ phone: "447700900001", body: "IN", waMessageId: "wamid.T1", authorName: "Sam", timestamp: "1762500000" });
  });

  it("a swipe-reply carries the quoted id and whether it was ours (Meta sends no quoted text)", () => {
    expect(inboundDmOf({ ...base, quotedId: "wamid.OFFER1", quotedFromUs: true })).toMatchObject({ quotedMessageId: "wamid.OFFER1", quotedFromMatchTime: true });
  });

  it("a username with no phone goes in with no phone: the pipeline's unknown sender (plan 5.4)", () => {
    const dm = inboundDmOf({ ...base, phone: null });
    expect(dm).not.toHaveProperty("phone");
    expect(dm).toMatchObject({ body: "IN", waMessageId: "wamid.T1" });
  });

  it("a message with no text is not a DM for the pipeline", () => {
    expect(inboundDmOf({ ...base, type: "reaction", text: null })).toBeNull();
  });
});
