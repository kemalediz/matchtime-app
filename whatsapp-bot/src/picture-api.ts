/**
 * PICTURE READING: the two calls to /api/whatsapp/picture (2026-10-14).
 *
 * Kept out of api.ts on purpose: the picture is the only thing the Pi ever
 * sends as bytes, and this file is where that can be checked in one place.
 * Like api.ts, it refuses to write in shadow mode (shadow.ts), which here
 * just means "no answer", and the picture is handed up as it was.
 *
 * Total: a failure of any kind is null. Never logs the body.
 */
import { config } from "./config.js";
import { refuseServerWriteInShadow } from "./shadow.js";
import type { PictureImage, PictureMetaForServer } from "./picture-reader.js";

export const PICTURE_CHECK_TIMEOUT_MS = 15_000;
export const PICTURE_READ_TIMEOUT_MS = 45_000;
const PATH = "/api/whatsapp/picture";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function post<T>(body: Record<string, unknown>, timeoutMs: number, fetchFn: Fetch): Promise<T | null> {
  const url = `${config.apiUrl}${PATH}`;
  const json = JSON.stringify(body);
  if (refuseServerWriteInShadow(url, json)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
      body: json,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function postPictureCheck(
  meta: PictureMetaForServer,
  fetchFn: Fetch = fetch,
): Promise<{ read: boolean; reason?: string } | null> {
  return post({ mode: "check", ...meta }, PICTURE_CHECK_TIMEOUT_MS, fetchFn);
}

export function postPictureRead(
  meta: PictureMetaForServer,
  image: PictureImage,
  fetchFn: Fetch = fetch,
): Promise<{ read: boolean; transcript?: string | null; reason?: string } | null> {
  return post(
    { mode: "read", ...meta, image: { data: image.data.toString("base64"), mediaType: image.mediaType } },
    PICTURE_READ_TIMEOUT_MS,
    fetchFn,
  );
}
