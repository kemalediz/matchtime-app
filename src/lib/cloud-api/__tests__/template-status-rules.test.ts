/**
 * Template status and category webhooks into `CloudTemplateStatus` rows
 * (plan 5.2 and 5.6, PR C6). The fixtures are the examples on Meta's
 * webhook reference pages, read 7 Nov 2026:
 *   WA/webhooks/reference/message_template_status_update
 *   WA/webhooks/reference/template_category_update
 * (WA = developers.facebook.com/documentation/business-messaging/whatsapp).
 */
import { describe, expect, it } from "vitest";
import { templateStatusChanges } from "../template-status-rules";

const envelope = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", time: 1674864290, changes: [{ field, value }] }],
});

/** Meta's "approved" example. */
const APPROVED = envelope("message_template_status_update", {
  event: "APPROVED",
  message_template_id: 594425479261596,
  message_template_name: "order_confirmation",
  message_template_language: "en_US",
  reason: "NONE",
  message_template_category: "UTILITY",
});

/** Meta's "rejected" example. */
const REJECTED = envelope("message_template_status_update", {
  event: "REJECTED",
  message_template_id: 1689556908129832,
  message_template_name: "abandoned_cart",
  message_template_language: "en_US",
  reason: "INVALID_FORMAT",
  message_template_category: "MARKETING",
  rejection_info: { reason: "The template has a variable at the start.", recommendation: "Move the variable." },
});

/** Meta's "category changed" example. */
const RECATEGORISED = envelope("template_category_update", {
  message_template_id: 278077987957091,
  message_template_name: "welcome_template",
  message_template_language: "en-US",
  previous_category: "UTILITY",
  new_category: "MARKETING",
});

/** Meta's "upcoming change" example: `new_category` is still the current one. */
const UPCOMING = envelope("template_category_update", {
  message_template_id: 278077987957091,
  message_template_name: "welcome_template",
  message_template_language: "en-US",
  correct_category: "MARKETING",
  new_category: "UTILITY",
  category_update_timestamp: 1746169200,
});

describe("templateStatusChanges", () => {
  it("an approval becomes one upsert, with Meta's id, status and category", () => {
    expect(templateStatusChanges(APPROVED)).toEqual([
      {
        kind: "upsert",
        name: "order_confirmation",
        language: "en_US",
        create: { metaTemplateId: "594425479261596", status: "APPROVED", category: "UTILITY", reason: null },
        update: { metaTemplateId: "594425479261596", status: "APPROVED", category: "UTILITY", reason: null },
      },
    ]);
  });

  it("a rejection keeps Meta's reason and what it recommends", () => {
    const [c] = templateStatusChanges(REJECTED);
    expect(c).toMatchObject({
      kind: "upsert",
      name: "abandoned_cart",
      update: { status: "REJECTED", category: "MARKETING", reason: "INVALID_FORMAT: The template has a variable at the start. Move the variable." },
    });
  });

  it("a pause carries Meta's title and description as the reason", () => {
    const [c] = templateStatusChanges(
      envelope("message_template_status_update", {
        event: "PAUSED",
        message_template_id: 1,
        message_template_name: "mt_pool_offer",
        message_template_language: "en_GB",
        reason: "NONE",
        other_info: { title: "FIRST_PAUSE", description: "Your template was paused for 3 hours." },
      }),
    );
    expect(c).toMatchObject({ kind: "upsert", language: "en_GB", update: { status: "PAUSED", reason: "FIRST_PAUSE: Your template was paused for 3 hours." } });
    // No category in the payload: the stored one is left as it is.
    expect(c.kind === "upsert" && "category" in c.update).toBe(false);
  });

  it("a status Meta adds later is still recorded, never refused", () => {
    const [c] = templateStatusChanges(
      envelope("message_template_status_update", { event: "PENDING_DELETION", message_template_id: 2, message_template_name: "mt_code", message_template_language: "tr", reason: null }),
    );
    expect(c).toMatchObject({ kind: "upsert", update: { status: "PENDING_DELETION", reason: null } });
  });

  it("a re-categorisation moves the category and keeps the previous one; the language is Meta's code with an underscore", () => {
    expect(templateStatusChanges(RECATEGORISED)).toEqual([
      {
        kind: "upsert",
        name: "welcome_template",
        language: "en_US",
        create: { metaTemplateId: "278077987957091", status: "UNKNOWN", category: "MARKETING", previousCategory: "UTILITY" },
        update: { metaTemplateId: "278077987957091", category: "MARKETING", previousCategory: "UTILITY" },
      },
    ]);
  });

  it("an upcoming re-categorisation changes nothing yet: a notice for the dashboard", () => {
    expect(templateStatusChanges(UPCOMING)).toEqual([
      { kind: "category-upcoming", name: "welcome_template", language: "en_US", currentCategory: "UTILITY", correctCategory: "MARKETING", at: new Date(1746169200 * 1000) },
    ]);
  });

  it("other fields, malformed entries and values the table would refuse are skipped", () => {
    expect(templateStatusChanges(null)).toEqual([]);
    expect(templateStatusChanges({ entry: "x" })).toEqual([]);
    expect(templateStatusChanges(envelope("messages", { messages: [] }))).toEqual([]);
    expect(templateStatusChanges(envelope("message_template_status_update", { event: "approved!", message_template_name: "mt_code", message_template_language: "en_GB" }))).toEqual([]);
    expect(templateStatusChanges(envelope("message_template_status_update", { event: "APPROVED", message_template_name: "Bad Name", message_template_language: "en_GB" }))).toEqual([]);
    expect(templateStatusChanges(envelope("message_template_status_update", { event: "APPROVED", message_template_name: "mt_code", message_template_language: "english" }))).toEqual([]);
    expect(templateStatusChanges(envelope("template_category_update", { message_template_name: "mt_code", message_template_language: "tr", previous_category: "UTILITY", new_category: "PROMO" }))).toEqual([]);
  });

  it("every change in one POST is read, in order", () => {
    const both = { object: "whatsapp_business_account", entry: [...APPROVED.entry, ...RECATEGORISED.entry] };
    expect(templateStatusChanges(both).map((c) => c.name)).toEqual(["order_confirmation", "welcome_template"]);
  });
});
