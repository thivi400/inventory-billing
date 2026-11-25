const moneyFmt = new Intl.NumberFormat('en-LK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats Sri Lankan Rupees consistently as "Rs. X,XXX.XX" in both English and Tamil.
 * Never prefix units or can counts with currency.
 */
export function formatMoney(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return 'Rs. 0.00';
  const num = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(num)) return 'Rs. 0.00';
  const neg = num < 0;
  return `${neg ? '-' : ''}Rs. ${moneyFmt.format(Math.abs(num))}`;
}

export function formatColomboDateTime(isoOrStr: string | null | undefined): string {
  if (!isoOrStr) return '—';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(isoOrStr)) {
    const [d, t] = isoOrStr.split(' ');
    return `${d} ${t.slice(0, 5)}`;
  }
  const d = new Date(isoOrStr);
  if (Number.isNaN(d.getTime())) return isoOrStr;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}
