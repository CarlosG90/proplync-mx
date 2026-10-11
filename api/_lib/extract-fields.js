/**
 * Proplync.mx · Turning the Extractor's loose answers into listing fields
 * -----------------------------------------------------------------------------
 * The model is asked for numbers but answers like a person reading a flyer:
 * "2.5", "1,250 m²", "$4.500.000", "4.5 millones", "pesos". Stripping every
 * non-digit (the old approach) turned "2.5" baths into 25 and "4.5 millones"
 * into 45, and anything that was not exactly "MXN" became USD.
 *
 * The agent publishes this under their own name, so a field we cannot read
 * comes back empty (and is listed as missing) rather than guessed.
 * -----------------------------------------------------------------------------
 */

const SCALE = [
  [/^\s*(millones?|mdp|mm)\b/i, 1e6],
  [/^\s*(mil|k)\b/i, 1e3]
];

/** A number from "2.5", "1,250.75", "$4.500.000", "4.5 millones"; null if none. */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value == null ? '' : value).trim();
  const m = text.match(/\d[\d.,]*(?:\s\d{3}(?!\d))*/);
  if (!m) return null;
  let digits = m[0].replace(/\s+/g, '').replace(/[.,]$/, '');
  const dots = (digits.match(/\./g) || []).length;
  const commas = (digits.match(/,/g) || []).length;
  if (dots && commas) {
    // whichever comes last is the decimal mark: 1,250.75 / 1.250,75
    digits = digits.lastIndexOf('.') > digits.lastIndexOf(',')
      ? digits.replace(/,/g, '')
      : digits.replace(/\./g, '').replace(',', '.');
  } else if (dots > 1 || commas > 1) {
    digits = digits.replace(/[.,]/g, '');                 // 4.500.000 / 4,500,000
  } else if (dots === 1 || commas === 1) {
    const frac = digits.split(/[.,]/)[1];
    // exactly three digits after a lone separator is a thousands group (4,500)
    digits = frac.length === 3 ? digits.replace(/[.,]/, '') : digits.replace(',', '.');
  }
  let n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const rest = text.slice(m.index + m[0].length);
  for (const [re, factor] of SCALE) if (re.test(rest)) { n *= factor; break; }
  return n;
}

/** Whole count (bedrooms, baths, parking). "2.5" baths -> 2, with half=true. */
export function parseCount(value, max = 100) {
  const n = parseAmount(value);
  if (n == null || n > max) return { value: null, half: false };
  return { value: Math.floor(n), half: n % 1 >= 0.25 };
}

/** "MXN" / "USD" from whatever the model wrote; '' when it did not say. */
export function parseCurrency(value) {
  const t = String(value == null ? '' : value).toUpperCase();
  if (/USD|DLL|D[OÓ]LAR|US\$/.test(t)) return 'USD';
  if (/MXN|\bM\.?\s?N\b\.?|PESO/.test(t)) return 'MXN';
  return '';
}
