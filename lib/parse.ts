/**
 * Parses a human-readable size ("1.98 GB") into bytes.
 *
 * Both trackers format sizes the same way - decimals, a space, a binary unit -
 * so this is shared. Returns 0 on anything unparseable; Torznab treats a
 * missing size as unknown rather than erroring out.
 */
export function parseSize(str: string | undefined | null): number {
  const m = /^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i.exec((str || '').trim());
  if (!m) return 0;
  const numStr = m[1];
  const unitStr = m[2];
  if (!numStr || !unitStr) return 0;
  const num = parseFloat(numStr.replace(',', ''));
  const unit = unitStr.toUpperCase();
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const mult = multipliers[unit];
  if (mult === undefined) return 0;
  return Math.round(num * mult);
}
