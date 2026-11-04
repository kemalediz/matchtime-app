/**
 * WhatsApp Cloud API vocabulary (plan MDs/whatsapp-cloud-api-plan-
 * 2026-11-04.md, sections 5.6 and 6). Pure: no imports.
 *
 * Meta's three template categories, as its API spells them. The
 * `CloudTemplateStatus` CHECKs (PR C2) carry exactly these values
 * (`cloud-api-schema-sql.test.ts`). A template Meta moves from UTILITY to
 * MARKETING keeps the old one in `previousCategory`, so the dashboard can
 * report the re-categorisation (plan 5.6).
 *
 * A template's STATUS is deliberately not a closed list here: Meta adds
 * statuses (PAUSED, LIMIT_EXCEEDED, ...) and a webhook carrying a new one
 * must still be recorded, never refused by a CHECK.
 */
export const CLOUD_TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;
export type CloudTemplateCategory = (typeof CLOUD_TEMPLATE_CATEGORIES)[number];
