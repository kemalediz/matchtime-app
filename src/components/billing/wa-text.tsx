/**
 * Renders WhatsApp-style *bold* in a string shared with the DMs (the club
 * fee tip) as <strong>, everything else as plain text.
 */
export function WaText({ text }: { text: string }) {
  const parts = text.split(/\*([^*]+)\*/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}
    </>
  );
}
