/** `month-setup.en.ts`, in Turkish. */
import type { MonthSetupStrings } from "./month-setup.en";

export const monthSetupTr: MonthSetupStrings = {
  held_notice: (p) =>
    [
      `📋 ${p.month} listesinin açılma zamanı geldi, ama bu MatchTime'ın grubunuzla ilk ayı, bu yüzden paylaşacağı kendi listesi yok.`,
      `${p.month} ayını grubunuzun listesiyle buradan başlatın: ${p.link}`,
      ...(p.inGroup ? ["Ya da listeyi bu gruba yapıştırın, isimleri önce sizinle kontrol edeyim."] : []),
      "Grubunuzun henüz listesi yoksa o sayfada boş bir liste açın, ben paylaşırım.",
      `O zamana kadar ${p.month} hakkında hiçbir şey paylaşmıyorum.`,
    ].join("\n"),

  next_title: (p) => `${p.month} ayını listenizle başlatın`,
  next_body: (p) =>
    `Grubunuzun ${p.month} için kullandığı listeyi yapıştırın. MatchTime isimleri oyuncularınızla eşleştirir, siz kontrol edersiniz, sonra ayı onlarla başlatır. Hemen ardından kendi listesini paylaşmaz: listeyi yalnızca biri bir şey değiştirdiğinde paylaşır.`,
  next_held: (p) => `Siz burada başlatana kadar MatchTime ${p.month} için liste paylaşmıyor.`,
  next_open_empty: (p) => `${p.month} için boş liste aç`,
  next_open_empty_hint: "MatchTime listeyi grubunuzda paylaşır, oyuncular orada yazılır.",
  next_opened: (p) => `${p.month} listesi açıldı`,
  next_posts_note: "Ayı böyle başlatmak hemen bir şey paylaşmaz. MatchTime listeyi biri bir şey değiştirdiğinde paylaşır.",
  next_break: (p) => `${p.month} ayında maç yok: sezon arası.`,

  col_games_committed: "Maç",
  games_hint: "Her maç için boş bırakın. \"Sadece 4\" diyen bir oyuncu için 4 yazın.",
  games_all: "Hepsi",
  games_of: (p) => `${p.of} maçtan ${p.games}`,
  games_save: "Kaydet",
  games_saved: "Maç sayısı kaydedildi",
  games_error: (p) =>
    p.key === "more-than-the-month"
      ? "Bu, ayın maç sayısından fazla."
      : p.key === "bad-games"
        ? "Tam bir maç sayısı yazın, ya da her maç için boş bırakın."
        : p.key === "locked"
          ? "Bu ödeme onaylandı. Maç sayısını bir yöneticiye değiştirtin."
          : p.key === "not-a-regular"
            ? "Maç sayısı yalnızca ayın daimi oyuncuları içindir."
            : "Kaydedilemedi. Tekrar deneyin.",
  my_games_label: (p) => `${p.of} maçın kaçında oynuyorsunuz?`,
  my_games_all: (p) => `${p.of} maçın hepsi`,

  break_title: "Sezon arası",
  break_body:
    "Kulübünüzün maç oynamadığı ayları işaretleyin. O aylarda liste açılmaz, maç oluşturulmaz ve hiçbir şey paylaşılmaz. Sonraki ay her zamanki gibi, oynanan son ayın daimi oyuncularıyla başlar.",
  break_save: "Kaydet",
  break_saved: "Sezon arası kaydedildi",
  break_error: (p) =>
    p.key === "month-exists"
      ? `${p.month ?? "O ay"} burada zaten başladı, sezon arası olamaz. Önce oyuncularını aydan çıkarın.`
      : p.key === "bad-months"
        ? "Bu aydan başlayarak en fazla bir yıl sonrasına kadar ay seçin."
        : "Kaydedilemedi. Tekrar deneyin.",
  break_kept_games: (p) =>
    p.count === 1
      ? "O aylardaki 1 maçta zaten oyuncu var. Oynanmayacaksa maç sayfasından iptal edin."
      : `O aylardaki ${p.count} maçta zaten oyuncu var. Oynanmayacaklarsa maç sayfalarından iptal edin.`,

  hq_seed_proposal: (p) =>
    [
      `📋 ${p.month} listenizi okudum: ${p.count} oyuncu (${p.names}).`,
      ...(p.unknown ? [`Henüz tanımadığım isimler: ${p.unknown}. Onları oyuncu olarak ekleyin ya da onlarsız başlatın.`] : []),
      `${p.month} ayını onlarla başlatmak için EVET yazın. Önce kontrol etmek ya da değiştirmek için: ${p.link}`,
    ].join("\n"),
  hq_seed_applied: (p) => `✅ ${p.month} ${p.count} oyuncuyla başladı. Biri bir şey değiştirene kadar kendi listemi paylaşmayacağım.`,
  hq_seed_failed: (p) =>
    p.key === "already-started"
      ? `${p.month} zaten başladı, hiçbir şey değiştirilmedi.`
      : `${p.month} ayını o listeyle başlatamadım. Lütfen web sitesinde, Aylar sayfasından yapın.`,
};
