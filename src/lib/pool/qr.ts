/**
 * QR codes for the pool's links (slice G1): a leaflet run or a poster gets
 * its campaign link as a PNG (print at any size up to A4) or an SVG (for a
 * designer). Server side, through `qrcode` (node-qrcode, MIT): no QR encoder
 * was installed, and Reed-Solomon is not something to hand-roll.
 *
 * Error correction "M" (15%): survives a crease or a smudge on a leaflet
 * and keeps the code coarse enough to scan from a distance.
 */
import QRCode from "qrcode";

export type PoolQrFormat = "png" | "svg";

const OPTIONS = { errorCorrectionLevel: "M", margin: 4 } as const;
/** Pixels across: sharp at 8 cm on a 300 dpi print. */
const PNG_WIDTH = 1024;

export function poolQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { ...OPTIONS, type: "svg", color: { dark: "#000000", light: "#ffffff" } });
}

export function poolQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { ...OPTIONS, type: "png", width: PNG_WIDTH, color: { dark: "#000000", light: "#ffffff" } });
}

/** `?format=` off the download link: PNG unless SVG is asked for. */
export function readQrFormat(raw: string | null | undefined): PoolQrFormat {
  return raw === "svg" ? "svg" : "png";
}
