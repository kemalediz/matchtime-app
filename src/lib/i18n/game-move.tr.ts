/** Moving a game by WhatsApp, in Turkish. See `game-move.ts`. */
import type { GameMoveCopy, GameStayReason } from "./game-move";

const QUIET = "Oyuncu grubuna bir şey yazmadım.";
const EXAMPLE = "*@Match Time pazartesi maçını 20:15'e al*";

/** A short reason, for the weekly list. */
const short: Record<GameStayReason, string> = {
  started: "başladı bile",
  "set-by-hand": "elle kendi saatine alınmıştı",
  "into-the-past": "yeni saat geçti bile",
  "other-month": "başka bir aya geçerdi",
  "unreadable-time": "saati okunamadı",
  unchanged: "zaten o saatte",
  gone: "artık oynanmayacak",
};

const orList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} ya da ${items[items.length - 1]}` : items.join("");

export const GAME_MOVE_TR: GameMoveCopy = {
  movedOne: (p) =>
    (p.toDay
      ? `✅ Tamam: ${p.day} maçı taşındı, artık ${p.toDay}, saat ${p.time}.`
      : `✅ Tamam: ${p.day} maçının saati artık ${p.time} (önceden ${p.was}).`) + `\n${QUIET}`,
  stayedOne: (p) => {
    switch (p.reason) {
      case "started":
        return `${p.day} maçı başladı bile, olduğu gibi bıraktım.`;
      case "into-the-past":
        return `Saat ${p.to} geçti bile, ${p.day} maçını saat ${p.time} olarak bıraktım.`;
      case "other-month":
        return `Bu, ${p.day} maçını başka bir aya taşırdı, olduğu gibi bıraktım.`;
      case "unchanged":
        return `${p.day} maçı zaten saat ${p.time}.`;
      default:
        return `${p.day} maçını taşıyamadım. Oynanmış ya da iptal edilmiş olabilir.`;
    }
  },
  movedWeekly: (p) => {
    const lines = [`✅ Tamam: *${p.name}* bundan sonra her ${p.weekday} saat ${p.time}.`];
    if (p.moved.length > 0) lines.push(`Taşınan maçlar: ${p.moved.join(", ")}.`);
    if (p.stayed.length > 0) lines.push(`Olduğu gibi kalanlar: ${p.stayed.map((s) => `${s.day} (${short[s.reason]})`).join(", ")}.`);
    lines.push(QUIET);
    return lines.join("\n");
  },
  weeklyUnchanged: (p) => `*${p.name}* zaten her ${p.weekday} saat ${p.time}.`,
  which: (p) => `Hangi maçı taşıyayım (yeni zaman: ${p.change}): ${orList(p.options)}? Günü yazıp beni yeniden etiketleyin, örneğin ${EXAMPLE}.`,
  whichWeekly: (p) =>
    `Bundan sonra hangi haftalık maç değişsin (yeni zaman: ${p.change}): ${orList(p.options.map((o) => `*${o}*`))}? Adını yazıp beni yeniden etiketleyin.`,
  sayWhat: `Neye taşıyayım? Yeni saati ya da günü yazıp beni etiketleyin, örneğin ${EXAMPLE}.`,
  noGames: "Taşınacak yaklaşan bir maç yok.",
  invalid: `Bu saati kullanamadım. 20:15 gibi bir saatle beni etiketleyin, örneğin ${EXAMPLE}.`,
};
