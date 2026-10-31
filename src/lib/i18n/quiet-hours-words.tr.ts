/** Quiet hours by WhatsApp, in Turkish. See `quiet-hours-words.ts`. */
import type { QuietHoursWordsCopy } from "./quiet-hours-words";

const released = (n: number): string =>
  n === 1 ? "Beklettiğim mesaj şimdi gidiyor." : `Beklettiğim ${n} mesaj şimdi gidiyor.`;

export const QUIET_HOURS_WORDS_TR: QuietHoursWordsCopy = {
  off: (p) => `✅ Sessiz saatler kapalı. ${p.released > 0 ? released(p.released) : "Artık günün her saatinde mesaj atarım."}`,
  on: (p) =>
    `✅ Sessiz saatler açık: ${p.from} ile ${p.to} arası. Bu saatlerde mesajlarımı bekletirim.` +
    (p.released > 0 ? `\n${released(p.released)}` : ""),
  alreadyOff: "Sessiz saatler zaten kapalı.",
  alreadyOn: (p) => `Sessiz saatler zaten açık: ${p.from} ile ${p.to} arası.`,
  badTime: (p) =>
    `Bu saatleri anlayamadım. Şöyle etiketleyin: *@Match Time sessiz saatler 22:00 ile 08:00 arası*, ya da buradan ayarlayın: ${p.url}`,
  sameTime: (p) => `Sessiz saatler için iki farklı saat gerekiyor, örneğin 22:00 ile 08:00. Buradan da ayarlayabilirsiniz: ${p.url}`,
};
