/**
 * Asia/Colombo (UTC+05:30) date/time and Sri Lankan Rupee formatting utilities.
 * Money is always formatted as "Rs. X,XXX.XX" in both English and Tamil.
 * Units and can counts are NEVER prefixed with currency.
 */

export const COLOMBO_TZ = 'Asia/Colombo';

export function getColomboBusinessDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: COLOMBO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find((p) => p.type === 'year')?.value ?? '2026';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

export function getColomboTimestamp(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: COLOMBO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} +05:30`;
}

export function formatColomboDisplay(isoOrColombo: string): string {
  if (!isoOrColombo) return '—';
  // If already formatted as "YYYY-MM-DD HH:mm:ss +05:30"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(isoOrColombo)) {
    const [datePart, timePart] = isoOrColombo.split(' ');
    return `${datePart} ${timePart.slice(0, 5)}`;
  }
  const d = new Date(isoOrColombo);
  if (Number.isNaN(d.getTime())) return isoOrColombo;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: COLOMBO_TZ,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

const rsFormatter = new Intl.NumberFormat('en-LK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatRs(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) {
    return '—';
  }
  const negative = cents < 0;
  const absVal = Math.abs(cents) / 100;
  return `${negative ? '-' : ''}Rs. ${rsFormatter.format(absVal)}`;
}

export function parseRsToCents(input: string): number | null {
  const cleaned = input.replace(/Rs\.?/gi, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

export function formatCount(qty: number | null | undefined): string {
  if (qty === null || qty === undefined) return '—';
  return new Intl.NumberFormat('en-LK', { maximumFractionDigits: 0 }).format(qty);
}
