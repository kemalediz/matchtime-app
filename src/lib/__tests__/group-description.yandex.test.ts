/**
 * Yandex Maps links are kept in a group description (Turkish groups use
 * them), with the same strictness as the other map services. The rules
 * are in src/lib/group-description.ts (`mapLinkLength`). Pure: no
 * database, no model.
 *
 * The long forms follow Yandex's own documentation of its map links
 * (`ll`, `pt`, `z`, `rtext`, "/maps/org/<id>"). The short share form
 * "/maps/-/<code>" is from links seen in the wild, not from documentation.
 */
import { describe, expect, it } from "vitest";
import { LINK_REMOVED, NUMBER_REMOVED, isMapLink, maskGroupDescription } from "../group-description";

const X = NUMBER_REMOVED;
const LINK = LINK_REMOVED;
const mask = (s: string) => maskGroupDescription(s).text;

describe("Yandex map links are kept whole", () => {
  const kept = [
    // Long links, Turkish and English domains, coordinates percent-encoded
    // as a browser copies them.
    "https://yandex.com.tr/harita/11508/istanbul/?ll=28.979530%2C41.015137&z=12",
    "https://yandex.com/maps/11508/istanbul/?ll=28.979530%2C41.015137&mode=search&text=hali%20saha&z=14",
    "https://yandex.com.tr/maps/11508/istanbul/?ll=28.979530%2C41.015137&pt=28.979530%2C41.015137&z=16",
    // As Yandex documents them: plain commas, several points split by "~".
    "https://yandex.ru/maps/?pt=30.335429,59.944869~30.34127,59.89173&z=12&l=map",
    "yandex.com.tr/harita/?rtext=41.015137,28.979530~41.008200,28.978400&rtt=auto",
    "https://www.yandex.com/maps/org/kadikoy_hali_saha/1184371/?ll=29.02%2C40.99&z=17",
    // The old map hosts.
    "https://maps.yandex.com.tr/?ll=28.979530%2C41.015137&z=12",
    "http://maps.yandex.com/?ll=28.979530,41.015137&z=12",
    "https://maps.yandex.ru/?ll=30.310182,59.951059&z=12",
    // The short share form.
    "https://yandex.com.tr/harita/-/CDdkZQKt",
    "https://yandex.com/maps/-/CCUkR8~9",
    "https://yandex.ru/maps/-/CCUAb2Fz-C",
  ];
  it.each(kept)("%s", (url) => {
    expect(isMapLink(url)).toBe(true);
    const out = maskGroupDescription(`Saha: ${url}. Hesap 1234-56789012-5001`);
    expect(out.text).toBe(`Saha: ${url}. Hesap ${X}`);
    expect(out.links).toBe(0);
    expect(out.kept.mapLinks.map(([s, e]) => out.text.slice(s, e))).toEqual([url]);
    expect(mask(out.text)).toBe(out.text);
  });
});

describe("what is not a Yandex map link is removed like any other link", () => {
  const removed = [
    // Other Yandex products.
    "https://yandex.com.tr/search/?text=hali+saha",
    "https://yandex.com.tr/",
    "https://mail.yandex.com/?uid=1234",
    "https://disk.yandex.com.tr/d/AbCdEf",
    "https://yandex.com.tr/mapsx/11508",
    "https://yandex.com.tr/haritalar/11508",
    "https://yandex.com/pay/kemal",
    // Not Yandex's own domains, or not as written.
    "https://yandex.com.tr.evil.tld/maps/11508",
    "https://maps.yandex.com.evil.tld/x",
    "https://yandex.xyz/maps/11508",
    "https://evil.tld/yandex.com.tr/maps/11508",
    "https://maps.y\u0430ndex.com/?ll=28.97,41.01",
    "https://y\u0430ndex.com.tr/harita/-/CDdkZQKt",
    "https://yan\u200bdex.com.tr/harita/-/CDdkZQKt",
    "https://user@yandex.com/maps/11508",
    "https://yandex.com@evil.tld/maps/11508",
    "https://yandex.com:8080/maps/11508",
    "ftp://yandex.com/maps/11508",
    // A map link that carries something else.
    "https://yandex.com/maps/?text=05321234567",
    "https://yandex.com.tr/harita/?ll=28.97%2C41.01&tel=905321234567",
    "https://yandex.com/maps/?ll=28.97%2C41.01,05321234567",
    "https://yandex.com/maps/?u=https://monzo.me/kemal",
    "https://yandex.com/maps/?u=www.evil.tld",
    "https://yandex.com/maps/?to=kemal@evil.tld",
    "https://yandex.com.tr/harita/-/CDdkZQKt05321234567",
    "https://yandex.com.tr/harita/-/1234567",
    // An organisation link whose id is 9 digits or more is indistinguishable
    // from a link carrying a phone number: the digit limit is not relaxed.
    "https://yandex.ru/maps/org/1184371713",
  ];
  it.each(removed)("%s", (url) => {
    expect(isMapLink(url)).toBe(false);
    const out = maskGroupDescription(`Saha ${url} tamam`);
    expect(out.text).toBe(`Saha ${LINK} tamam`);
    expect(out.kept.mapLinks).toEqual([]);
    expect(mask(out.text)).toBe(out.text);
  });
});

describe("what is glued to a Yandex map link is judged", () => {
  const cases: Array<[string, string]> = [
    ["https://yandex.com.tr/harita/-/CDdkZQKt,05321234567", `https://yandex.com.tr/harita/-/CDdkZQKt,${X}`],
    ["\u{1f4cd}yandex.com/maps/-/CCUkR8~9\u{1f4de}05321234567", `\u{1f4cd}yandex.com/maps/-/CCUkR8~9\u{1f4de}${X}`],
    ["(https://yandex.com.tr/harita/-/CDdkZQKt)0532 123 45 67", `(https://yandex.com.tr/harita/-/CDdkZQKt)${X}`],
    ["https://yandex.com.tr/harita/-/CDdkZQKt,monzo.me/kemal", `https://yandex.com.tr/harita/-/CDdkZQKt,${LINK}`],
    ["https://yandex.com.tr/harita/-/CDdkZQKt?utm=1", "https://yandex.com.tr/harita/-/CDdkZQKt?utm=1"],
    [
      "https://yandex.com.tr/harita/11508/istanbul/?ll=28.979530%2C41.015137&z=12\u{1f4de}05321234567",
      `https://yandex.com.tr/harita/11508/istanbul/?ll=28.979530%2C41.015137&z=12\u{1f4de}${X}`,
    ],
    ["https://yandex.com.tr/harita/11508/istanbul/?ll=28.979530%2C41.015137&z=12 0532 123 45 67", `https://yandex.com.tr/harita/11508/istanbul/?ll=28.979530%2C41.015137&z=12 ${X}`],
    // A link ends at a square bracket, so the bracketed form keeps its
    // start and loses the coordinates after it.
    ["https://yandex.ru/maps/?whatshere[point]=37.444076,55.776788&whatshere[zoom]=17", `https://yandex.ru/maps/?whatshere[point]=${X}&whatshere[zoom]=17`],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(mask(input)).toBe(expected);
    expect(mask(mask(input))).toBe(mask(input));
  });
});
