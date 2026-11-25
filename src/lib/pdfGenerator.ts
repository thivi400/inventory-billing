import { jsPDF } from 'jspdf';
import { formatColomboDisplay, formatRs } from '../shared/colomboTime.ts';
import { localizedName, methodLabel, unitLabel } from '../shared/i18n.ts';
import type { InvoiceRecord, Language } from '../shared/types.ts';

export type ReceiptFormat = 'a4' | 'thermal80';

/**
 * Programmatic offline PDF generator using the browser's native HarfBuzz text shaper
 * via high-DPI HTML5 Canvas + bundled Noto Sans Tamil / Plus Jakarta Sans fonts.
 * Guarantees accurate Tamil glyph shaping, full invoice number, multi-page A4 support,
 * zero internal costs/profit, and NO print dialog!
 */
export async function downloadInvoicePdf(
  invoice: InvoiceRecord,
  lang: Language,
  format: ReceiptFormat
): Promise<void> {
  if (typeof document !== 'undefined' && document.fonts) {
    await document.fonts.ready;
  }

  const snap = invoice.snapshot;
  const isThermal = format === 'thermal80';
  const uiFont = '"Nunito Variable", "Noto Sans Tamil Variable", "Nunito", "Noto Sans Tamil", sans-serif';
  const monoFont = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

  // Canvas dimensions in pixels at high resolution
  const pageWidthPx = isThermal ? 640 : 1240;
  const marginX = isThermal ? 32 : 72;
  const contentWidth = pageWidthPx - marginX * 2;

  // Measure lines & build drawing commands
  type DrawOp =
    | { type: 'text'; x: number; y: number; text: string; font: string; color: string; align?: CanvasTextAlign }
    | { type: 'line'; x1: number; y: number; x2: number; dashed?: boolean; color?: string }
    | { type: 'rect'; x: number; y: number; w: number; h: number; fill: string; stroke?: string };

  const ops: DrawOp[] = [];
  let cursorY = isThermal ? 40 : 68;

  const measureCtx = document.createElement('canvas').getContext('2d')!;

  const wrapText = (text: string, font: string, maxWidth: number): string[] => {
    measureCtx.font = font;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const lines: string[] = [];
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = `${current} ${words[i]}`;
      if (measureCtx.measureText(test).width <= maxWidth) {
        current = test;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
    return lines;
  };

  // CANCELED banner if invoice is canceled
  if (invoice.status === 'canceled') {
    const bannerH = isThermal ? 48 : 56;
    ops.push({ type: 'rect', x: marginX, y: cursorY, w: contentWidth, h: bannerH, fill: '#FEF2F2', stroke: '#DC2626' });
    ops.push({
      type: 'text',
      x: pageWidthPx / 2,
      y: cursorY + (isThermal ? 32 : 38),
      text: lang === 'ta' ? 'ரத்து செய்யப்பட்ட பில் (CANCELED)' : 'CANCELED INVOICE',
      font: `700 ${isThermal ? 22 : 26}px ${uiFont}`,
      color: '#B91C1C',
      align: 'center',
    });
    cursorY += bannerH + 20;
  }

  // Shop header (ONLY configured fields — never fabricate!)
  const shopName = localizedName(lang, snap.shop.nameEn ?? '', snap.shop.nameTa);
  const shopAddr = localizedName(lang, snap.shop.addressEn ?? '', snap.shop.addressTa);
  if (shopName) {
    for (const line of wrapText(shopName, `700 ${isThermal ? 26 : 34}px ${uiFont}`, contentWidth)) {
      ops.push({
        type: 'text',
        x: isThermal ? pageWidthPx / 2 : marginX,
        y: cursorY,
        text: line,
        font: `700 ${isThermal ? 26 : 34}px ${uiFont}`,
        color: '#0F172A',
        align: isThermal ? 'center' : 'left',
      });
      cursorY += isThermal ? 34 : 44;
    }
  }
  if (shopAddr) {
    for (const line of wrapText(shopAddr, `400 ${isThermal ? 18 : 22}px ${uiFont}`, contentWidth)) {
      ops.push({
        type: 'text',
        x: isThermal ? pageWidthPx / 2 : marginX,
        y: cursorY,
        text: line,
        font: `400 ${isThermal ? 18 : 22}px ${uiFont}`,
        color: '#334155',
        align: isThermal ? 'center' : 'left',
      });
      cursorY += isThermal ? 26 : 30;
    }
  }
  const shopMeta: string[] = [];
  if (snap.shop.phone) shopMeta.push(`${lang === 'ta' ? 'தொலைபேசி' : 'Tel'}: ${snap.shop.phone}`);
  if (snap.shop.taxId) shopMeta.push(`${lang === 'ta' ? 'வரி எண்' : 'Tax ID'}: ${snap.shop.taxId}`);
  if (shopMeta.length > 0) {
    ops.push({
      type: 'text',
      x: isThermal ? pageWidthPx / 2 : marginX,
      y: cursorY,
      text: shopMeta.join('   |   '),
      font: `500 ${isThermal ? 18 : 20}px ${uiFont}`,
      color: '#475569',
      align: isThermal ? 'center' : 'left',
    });
    cursorY += isThermal ? 28 : 34;
  }

  cursorY += 8;
  ops.push({ type: 'line', x1: marginX, y: cursorY, x2: pageWidthPx - marginX, color: '#CBD5E1' });
  cursorY += isThermal ? 28 : 36;

  // Invoice metadata block
  const labelFont = `600 ${isThermal ? 18 : 20}px ${uiFont}`;
  const valFont = `600 ${isThermal ? 18 : 21}px ${uiFont}`;
  const idFont = `600 ${isThermal ? 19 : 22}px ${monoFont}`;

  ops.push({
    type: 'text',
    x: marginX,
    y: cursorY,
    text: lang === 'ta' ? 'பில் எண்:' : 'Invoice No:',
    font: labelFont,
    color: '#475569',
  });
  ops.push({
    type: 'text',
    x: pageWidthPx - marginX,
    y: cursorY,
    text: snap.invoiceNumber,
    font: idFont,
    color: '#0F172A',
    align: 'right',
  });
  cursorY += isThermal ? 28 : 32;

  ops.push({
    type: 'text',
    x: marginX,
    y: cursorY,
    text: lang === 'ta' ? 'தேதி (Colombo):' : 'Date (Colombo):',
    font: labelFont,
    color: '#475569',
  });
  ops.push({
    type: 'text',
    x: pageWidthPx - marginX,
    y: cursorY,
    text: formatColomboDisplay(snap.invoiceDateColombo),
    font: valFont,
    color: '#0F172A',
    align: 'right',
  });
  cursorY += isThermal ? 28 : 32;

  const custDisplay = localizedName(lang, snap.customerName, snap.customerNameTa);
  ops.push({
    type: 'text',
    x: marginX,
    y: cursorY,
    text: lang === 'ta' ? 'வாடிக்கையாளர்:' : 'Customer:',
    font: labelFont,
    color: '#475569',
  });
  ops.push({
    type: 'text',
    x: pageWidthPx - marginX,
    y: cursorY,
    text: custDisplay,
    font: valFont,
    color: '#0F172A',
    align: 'right',
  });
  cursorY += isThermal ? 28 : 32;

  ops.push({
    type: 'text',
    x: marginX,
    y: cursorY,
    text: lang === 'ta' ? 'பணியாளர்:' : 'Staff:',
    font: labelFont,
    color: '#475569',
  });
  ops.push({
    type: 'text',
    x: pageWidthPx - marginX,
    y: cursorY,
    text: snap.staffName,
    font: valFont,
    color: '#0F172A',
    align: 'right',
  });
  cursorY += isThermal ? 22 : 28;

  ops.push({ type: 'line', x1: marginX, y: cursorY, x2: pageWidthPx - marginX, color: '#0F172A' });
  cursorY += isThermal ? 28 : 34;

  // Table header
  const colQtyX = isThermal ? marginX + contentWidth * 0.54 : marginX + contentWidth * 0.55;
  const colRateX = isThermal ? marginX + contentWidth * 0.76 : marginX + contentWidth * 0.77;
  const colTotalX = pageWidthPx - marginX;
  const nameMaxW = (colQtyX - marginX) - 16;

  const thFont = `700 ${isThermal ? 17 : 20}px ${uiFont}`;
  ops.push({ type: 'text', x: marginX, y: cursorY, text: lang === 'ta' ? 'பொருள்' : 'Item', font: thFont, color: '#334155' });
  ops.push({ type: 'text', x: colQtyX, y: cursorY, text: lang === 'ta' ? 'அளவு' : 'Qty', font: thFont, color: '#334155', align: 'right' });
  ops.push({ type: 'text', x: colRateX, y: cursorY, text: lang === 'ta' ? 'விலை' : 'Rate', font: thFont, color: '#334155', align: 'right' });
  ops.push({ type: 'text', x: colTotalX, y: cursorY, text: lang === 'ta' ? 'தொகை' : 'Amount', font: thFont, color: '#334155', align: 'right' });
  cursorY += 14;
  ops.push({ type: 'line', x1: marginX, y: cursorY, x2: pageWidthPx - marginX, color: '#CBD5E1' });
  cursorY += isThermal ? 28 : 34;

  // Item rows (strictly from snapshot — never internal costs or UUIDs)
  const itemFont = `500 ${isThermal ? 18 : 21}px ${uiFont}`;
  for (const line of snap.lines) {
    const desc = `${localizedName(lang, line.nameEn, line.nameTa)} (${unitLabel(lang, line.soldBy)})`;
    const wrapped = wrapText(desc, itemFont, nameMaxW);
    const startY = cursorY;

    for (let i = 0; i < wrapped.length; i++) {
      ops.push({
        type: 'text',
        x: marginX,
        y: cursorY,
        text: wrapped[i],
        font: itemFont,
        color: '#0F172A',
      });
      if (i === 0) {
        ops.push({ type: 'text', x: colQtyX, y: startY, text: String(line.qty), font: itemFont, color: '#0F172A', align: 'right' });
        ops.push({ type: 'text', x: colRateX, y: startY, text: formatRs(line.unitPriceCents), font: itemFont, color: '#334155', align: 'right' });
        ops.push({ type: 'text', x: colTotalX, y: startY, text: formatRs(line.lineTotalCents), font: `600 ${isThermal ? 18 : 21}px ${uiFont}`, color: '#0F172A', align: 'right' });
      }
      cursorY += isThermal ? 28 : 32;
    }
    cursorY += 6;
  }

  ops.push({ type: 'line', x1: marginX, y: cursorY, x2: pageWidthPx - marginX, color: '#0F172A' });
  cursorY += isThermal ? 30 : 38;

  // Financial Summary Rows
  const addSummaryRow = (label: string, value: string, bold = false, color = '#0F172A') => {
    const f = `${bold ? 700 : 500} ${isThermal ? (bold ? 21 : 19) : bold ? 24 : 21}px ${uiFont}`;
    ops.push({ type: 'text', x: marginX, y: cursorY, text: label, font: f, color: bold ? '#0F172A' : '#334155' });
    ops.push({ type: 'text', x: colTotalX, y: cursorY, text: value, font: f, color, align: 'right' });
    cursorY += isThermal ? 30 : 36;
  };

  addSummaryRow(lang === 'ta' ? 'கூட்டுத்தொகை' : 'Subtotal', formatRs(snap.subtotalCents));
  if (snap.discountCents > 0) {
    addSummaryRow(lang === 'ta' ? 'தள்ளுபடி' : 'Discount', `-${formatRs(snap.discountCents)}`);
  }
  addSummaryRow(lang === 'ta' ? 'மொத்த பில் தொகை' : 'Invoice Total', formatRs(snap.invoiceTotalCents), true);

  cursorY += 6;
  ops.push({ type: 'line', x1: marginX, y: cursorY, x2: pageWidthPx - marginX, dashed: true, color: '#CBD5E1' });
  cursorY += isThermal ? 28 : 34;

  addSummaryRow(
    lang === 'ta' ? 'பணம் செலுத்தும் முறை' : 'Payment Method',
    methodLabel(lang, snap.paymentMethod)
  );
  addSummaryRow(lang === 'ta' ? 'பெற்ற தொகை' : 'Amount Tendered', formatRs(snap.tenderedCents));
  addSummaryRow(lang === 'ta' ? 'பில் கட்டியது' : 'Invoice Paid', formatRs(snap.invoicePaidCents), false, '#15803D');
  if (snap.oldDebtAppliedCents > 0) {
    addSummaryRow(lang === 'ta' ? 'பழைய கடனில் கழித்தது' : 'Old Debt Applied', formatRs(snap.oldDebtAppliedCents), false, '#15803D');
  }
  if (snap.changeCents > 0) {
    addSummaryRow(lang === 'ta' ? 'மீதிப் பணம்' : 'Change', formatRs(snap.changeCents));
  }
  if (snap.invoiceDueCents > 0) {
    addSummaryRow(lang === 'ta' ? 'இந்த பில் பாக்கி' : 'Invoice Due', formatRs(snap.invoiceDueCents), true, '#92400E');
  }
  addSummaryRow(
    lang === 'ta' ? 'புதிய கணக்கு பாக்கி' : 'Resulting Account Balance',
    formatRs(snap.resultingBalanceCents),
    true,
    snap.resultingBalanceCents > 0 ? '#92400E' : '#0F172A'
  );

  // Returnable cans issued block
  if (snap.returnableCansIssued.length > 0) {
    cursorY += 8;
    ops.push({ type: 'line', x1: marginX, y: cursorY, x2: pageWidthPx - marginX, dashed: true, color: '#7DD3FC' });
    cursorY += isThermal ? 28 : 34;
    ops.push({
      type: 'text',
      x: marginX,
      y: cursorY,
      text: lang === 'ta' ? 'வழங்கிய திருப்பித் தரும் கேன்கள்:' : 'Returnable Cans Issued:',
      font: `700 ${isThermal ? 19 : 21}px ${uiFont}`,
      color: '#0369A1',
    });
    cursorY += isThermal ? 28 : 32;
    for (const c of snap.returnableCansIssued) {
      ops.push({
        type: 'text',
        x: marginX,
        y: cursorY,
        text: localizedName(lang, c.nameEn, c.nameTa),
        font: itemFont,
        color: '#0F172A',
      });
      ops.push({
        type: 'text',
        x: colTotalX,
        y: cursorY,
        text: `${c.qty}`,
        font: `700 ${isThermal ? 19 : 21}px ${uiFont}`,
        color: '#0369A1',
        align: 'right',
      });
      cursorY += isThermal ? 26 : 30;
    }
  }

  cursorY += isThermal ? 32 : 48;

  // Render full content onto an offscreen canvas
  const totalHeightPx = Math.max(cursorY, isThermal ? 400 : 1754);
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = pageWidthPx;
  fullCanvas.height = totalHeightPx;
  const ctx = fullCanvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);

  for (const op of ops) {
    if (op.type === 'rect') {
      ctx.fillStyle = op.fill;
      ctx.fillRect(op.x, op.y, op.w, op.h);
      if (op.stroke) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      }
    } else if (op.type === 'line') {
      ctx.save();
      ctx.strokeStyle = op.color ?? '#CBD5E1';
      ctx.lineWidth = 2;
      if (op.dashed) ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y);
      ctx.lineTo(op.x2, op.y);
      ctx.stroke();
      ctx.restore();
    } else if (op.type === 'text') {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align ?? 'left';
      ctx.fillText(op.text, op.x, op.y);
    }
  }

  // Package into jsPDF (A4 multi-page or 80mm thermal roll)
  if (isThermal) {
    const pdfWidthMm = 80;
    const pdfHeightMm = Math.max(100, (totalHeightPx / pageWidthPx) * pdfWidthMm);
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [pdfWidthMm, pdfHeightMm],
    });
    const imgData = fullCanvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidthMm, pdfHeightMm);
    pdf.save(`${snap.invoiceNumber}-80mm-${lang}.pdf`);
  } else {
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const a4W = 210;
    const a4H = 297;
    const sliceHeightPx = Math.floor((a4H / a4W) * pageWidthPx);
    let offsetY = 0;
    let pageIndex = 0;

    while (offsetY < totalHeightPx) {
      const currentSliceH = Math.min(sliceHeightPx, totalHeightPx - offsetY);
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = pageWidthPx;
      sliceCanvas.height = currentSliceH;
      const sctx = sliceCanvas.getContext('2d')!;
      sctx.fillStyle = '#FFFFFF';
      sctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      sctx.drawImage(
        fullCanvas,
        0,
        offsetY,
        pageWidthPx,
        currentSliceH,
        0,
        0,
        pageWidthPx,
        currentSliceH
      );

      if (pageIndex > 0) pdf.addPage();
      const sliceMmH = (currentSliceH / pageWidthPx) * a4W;
      pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', 0, 0, a4W, sliceMmH);
      offsetY += sliceHeightPx;
      pageIndex += 1;
    }
    pdf.save(`${snap.invoiceNumber}-A4-${lang}.pdf`);
  }
}
