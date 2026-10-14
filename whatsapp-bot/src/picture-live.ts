/**
 * PICTURE READING: the reader the production Baileys driver uses, wired to
 * the real pieces (2026-10-14). Tests build their own with
 * `createPictureReader` and stubs; `makeBaileysDriver` has no reader unless
 * it is given one, so no driver test can reach the server through this.
 *
 * Only the players' groups the bot monitors: an admin group, a silent group
 * and a DM never get here (`isMonitoredGroup` excludes the first two, and
 * the reader looks at groups only).
 */
import { isMonitoredGroup } from "./handlers.js";
import { postPictureCheck, postPictureRead } from "./picture-api.js";
import { downloadPicture, shrinkPicture } from "./baileys/picture-image.js";
import { createPictureReader, type PictureReader } from "./picture-reader.js";

export function createLivePictureReader(): PictureReader {
  return createPictureReader({
    isMonitored: isMonitoredGroup,
    check: (meta) => postPictureCheck(meta),
    download: (raw) => downloadPicture(raw),
    shrink: (bytes) => shrinkPicture(bytes),
    read: (meta, image) => postPictureRead(meta, image),
  });
}
