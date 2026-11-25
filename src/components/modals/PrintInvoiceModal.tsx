import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../context/AppContext';
import { downloadInvoicePdf } from '../../lib/pdfGenerator';
import type { CreatedInvoice } from '../../types';
import type { InvoiceRecord } from '../../shared/types';
import { formatMoney } from '../../utils/formatters';
import { Icon } from '../Icon';

function createdToInvoiceRecord(inv: CreatedInvoice): InvoiceRecord {
  const subtotalCents = Math.round((inv.subtotal ?? 0) * 100);
  const discountCents = Math.round((inv.discount ?? 0) * 100);
  const totalCents = Math.round((inv.total ?? Math.max(0, (inv.subtotal ?? 0) - (inv.discount ?? 0))) * 100);
  const amountPaidCents = Math.round((inv.amount_paid ?? 0) * 100);
  const oldDebtAppliedCents = Math.round((inv.applied_to_old_debt ?? 0) * 100);
  const changeCents = Math.round((inv.change_returned ?? 0) * 100);
  const tenderedCents = Math.round(
    (inv.cash_received ?? (inv.amount_paid ?? 0) + (inv.applied_to_old_debt ?? 0) + (inv.change_returned ?? 0)) * 100,
  );
  const dueCents = Math.round((inv.balance_due ?? Math.max(0, (totalCents - amountPaidCents) / 100)) * 100);
  const resultingBalanceCents = Math.round((inv.customer_balance ?? 0) * 100);
  const priorBalanceCents = Math.round((inv.previous_balance ?? 0) * 100);

  return {
    id: inv.sale_id || inv.invoice_number,
    invoiceNumber: inv.invoice_number,
    customerId: '',
    staffId: '',
    staffName: inv.staff_name || 'Staff',
    status: inv.status === 'cancelled' ? 'canceled' : 'active',
    cancelReason: inv.cancel_reason ?? null,
    canceledAt: null,
    businessDateColombo: String(inv.date || '').slice(0, 10),
    createdAt: inv.date || '',
    returnedLines: [],
    snapshot: {
      invoiceNumber: inv.invoice_number,
      invoiceDateColombo: inv.date || '',
      businessDateColombo: String(inv.date || '').slice(0, 10),
      customerId: '',
      customerName: inv.customer_name,
      customerNameTa: inv.customer_name_ta || '',
      customerPhone: inv.customer_phone || '',
      customerAddress: inv.customer_address || '',
      staffId: '',
      staffName: inv.staff_name || 'Staff',
      shop: {
        nameEn: inv.shop?.name_en || '',
        nameTa: inv.shop?.name_ta || '',
        addressEn: inv.shop?.address_en || '',
        addressTa: inv.shop?.address_ta || '',
        phone: inv.shop?.phone || '',
        taxId: inv.shop?.tax_id || '',
      },
      lines: inv.items.map((it) => ({
        productTypeId: it.type_id || String(it.id),
        sku: it.sku || '',
        nameEn: it.name,
        nameTa: it.ta || it.name,
        soldBy: (['bottle', 'can', 'case', 'pack', 'unit'].includes(it.unit) ? it.unit : 'unit') as
          | 'bottle'
          | 'can'
          | 'case'
          | 'pack'
          | 'unit',
        isReturnable: false,
        qty: it.quantity,
        unitPriceCents: Math.round(it.price * 100),
        lineTotalCents: Math.round(it.subtotal * 100),
      })),
      subtotalCents,
      discountCents,
      invoiceTotalCents: totalCents,
      paymentMethod: inv.payment_method === 'bank' ? 'bank_transfer' : 'cash',
      tenderedCents,
      invoicePaidCents: amountPaidCents,
      oldDebtAppliedCents,
      changeCents,
      invoiceDueCents: dueCents,
      priorBalanceCents,
      resultingBalanceCents,
      returnableCansIssued: (inv.cans_issued || []).map((c) => ({
        productTypeId: c.type_id,
        nameEn: c.name,
        nameTa: c.ta || c.name,
        qty: c.quantity,
      })),
    },
  };
}

export function PrintInvoiceModal({
  invoice,
  initialFormat = 'thermal',
  onClose,
  onRetry,
}: {
  invoice: CreatedInvoice;
  initialFormat?: 'a4' | 'thermal';
  onClose: () => void;
  onRetry?: () => void;
}) {
  const { lang, showToast } = useApp();
  const [format, setFormat] = useState<'a4' | 'thermal'>(initialFormat);
  const [docLang, setDocLang] = useState<'en' | 'ta'>(lang);
  const [downloading, setDownloading] = useState(false);

  const isTa = docLang === 'ta';
  const isCanceled = invoice.status === 'cancelled';
  const total = invoice.total ?? Math.max(0, invoice.subtotal - (invoice.discount ?? 0));

  const shopName = isTa
    ? invoice.shop?.name_ta || invoice.shop?.name_en || ''
    : invoice.shop?.name_en || invoice.shop?.name_ta || '';
  const shopAddress = isTa
    ? invoice.shop?.address_ta || invoice.shop?.address_en || ''
    : invoice.shop?.address_en || invoice.shop?.address_ta || '';
  const shopPhone = invoice.shop?.phone || '';
  const shopTaxId = invoice.shop?.tax_id || '';

  const customerName = isTa
    ? invoice.customer_name_ta || invoice.customer_name
    : invoice.customer_name;

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      await downloadInvoicePdf(
        createdToInvoiceRecord(invoice),
        docLang,
        format === 'thermal' ? 'thermal80' : 'a4',
      );
      showToast(
        lang === 'ta' ? 'PDF கோப்பு பதிவிறக்கப்பட்டது.' : 'PDF file downloaded directly.',
        'success',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'PDF download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const modalContent = (
    <div
      className={`modal-backdrop invoice-print-host ${format === 'a4' ? 'invoice-print-a4' : 'invoice-print-thermal'}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Invoice ${invoice.invoice_number}`}
    >
      <div className="modal-dialog print-modal-dialog" style={{ maxWidth: format === 'a4' ? 860 : 460 }}>
        <div className="modal-header no-print" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>
              {invoice.invoice_number}
              {isCanceled && (
                <span
                  style={{
                    marginLeft: 8,
                    padding: '2px 8px',
                    fontSize: 11,
                    fontWeight: 900,
                    background: '#fef2f2',
                    color: '#dc2626',
                    border: '1px solid #fecaca',
                    borderRadius: 6,
                  }}
                >
                  CANCELED
                </span>
              )}
            </h3>
            <small style={{ color: '#64748b' }}>{customerName}</small>
          </div>

          <div className="print-controls-bar" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div className="format-pills" style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className={format === 'a4' ? 'active' : ''}
                onClick={() => setFormat('a4')}
              >
                A4
              </button>
              <button
                type="button"
                className={format === 'thermal' ? 'active' : ''}
                onClick={() => setFormat('thermal')}
              >
                80mm
              </button>
            </div>

            <div className="format-pills" style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className={docLang === 'en' ? 'active' : ''}
                onClick={() => setDocLang('en')}
              >
                EN
              </button>
              <button
                type="button"
                className={docLang === 'ta' ? 'active' : ''}
                onClick={() => setDocLang('ta')}
              >
                தமிழ்
              </button>
            </div>

            <button type="button" className="modal-close-btn" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="printable-scroll-wrapper" style={{ maxHeight: '68vh', overflowY: 'auto', margin: '12px 0' }}>
          {format === 'a4' ? (
            <div className="pdf-preview-container">
              <div className="pdf-preview-toolbar no-print">
                <span>{invoice.invoice_number} • A4</span>
                <span>{isTa ? 'தமிழ்' : 'English'}</span>
              </div>
              <div className="pdf-preview-sheet">
                <article className="a4-invoice" style={{ padding: 28, color: '#0f172a', background: '#fff' }}>
                  {isCanceled && (
                    <div
                      style={{
                        padding: '10px 14px',
                        marginBottom: 14,
                        background: '#fef2f2',
                        border: '2px solid #dc2626',
                        color: '#b91c1c',
                        fontWeight: 900,
                        textAlign: 'center',
                        borderRadius: 6,
                      }}
                    >
                      {isTa ? 'ரத்து செய்யப்பட்ட பில் (CANCELED INVOICE)' : 'CANCELED INVOICE'}
                      {invoice.cancel_reason ? ` — ${invoice.cancel_reason}` : ''}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #0f172a', paddingBottom: 14, marginBottom: 16 }}>
                    <div>
                      {shopName && <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>{shopName}</h2>}
                      {shopAddress && <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#334155' }}>{shopAddress}</p>}
                      {(shopPhone || shopTaxId) && (
                        <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#475569' }}>
                          {shopPhone ? `${isTa ? 'தொலைபேசி' : 'Tel'}: ${shopPhone}` : ''}
                          {shopPhone && shopTaxId ? '  |  ' : ''}
                          {shopTaxId ? `${isTa ? 'வரி எண்' : 'Tax ID'}: ${shopTaxId}` : ''}
                        </p>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>
                        {isTa ? 'விற்பனை பில்' : 'WHOLESALE INVOICE'}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 900, marginTop: 2 }}>{invoice.invoice_number}</div>
                      <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{invoice.date}</div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, fontSize: 13 }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>
                        {isTa ? 'வாடிக்கையாளர்' : 'Bill To'}
                      </div>
                      <b style={{ fontSize: 15 }}>{customerName}</b>
                      {invoice.customer_phone && <div>{invoice.customer_phone}</div>}
                      {invoice.customer_address && <div style={{ color: '#475569' }}>{invoice.customer_address}</div>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>
                        {isTa ? 'பணியாளர்' : 'Served By'}
                      </div>
                      <b>{invoice.staff_name}</b>
                      <div style={{ color: '#475569', marginTop: 2 }}>
                        {isTa ? 'முறை' : 'Method'}:{' '}
                        <b>
                          {invoice.payment_method === 'bank'
                            ? isTa
                              ? 'வங்கி பரிமாற்றம்'
                              : 'Bank Transfer'
                            : isTa
                              ? 'ரொக்கம்'
                              : 'Cash'}
                        </b>
                      </div>
                    </div>
                  </div>

                  <table className="a4-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
                    <thead>
                      <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #cbd5e1', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px' }}>#</th>
                        <th style={{ padding: '8px 10px' }}>{isTa ? 'பொருள்' : 'Description'}</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>{isTa ? 'அளவு' : 'Qty'}</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>{isTa ? 'விலை' : 'Rate'}</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>{isTa ? 'தொகை' : 'Amount'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.items.map((item, idx) => (
                        <tr key={String(item.id)} style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '8px 10px' }}>{idx + 1}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                            {isTa && item.ta ? item.ta : item.name}
                            <span style={{ color: '#64748b', fontWeight: 600, fontSize: 11, marginLeft: 6 }}>
                              ({item.unit})
                            </span>
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' }} className="tabular-nums">
                            {item.quantity}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' }} className="tabular-nums">
                            {formatMoney(item.price)}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800 }} className="tabular-nums">
                            {formatMoney(item.subtotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="a4-bottom-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, borderTop: '1px solid #cbd5e1', paddingTop: 12 }}>
                    <div style={{ fontSize: 12, color: '#334155' }}>
                      {invoice.cans_issued && invoice.cans_issued.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <b style={{ display: 'block', marginBottom: 4, color: '#0369a1' }}>
                            {isTa ? 'வழங்கிய திருப்பித் தரும் கேன்கள்:' : 'Returnable Cans Issued:'}
                          </b>
                          {invoice.cans_issued.map((c) => (
                            <div key={c.type_id}>
                              {isTa && c.ta ? c.ta : c.name}: <b>{c.quantity}</b>
                            </div>
                          ))}
                        </div>
                      )}
                      {invoice.cans_returned > 0 && (
                        <div>
                          {isTa ? 'பெற்ற காலி கேன்கள்:' : 'Empty Cans Returned:'} <b>{invoice.cans_returned}</b>
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'grid', gap: 5, fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{isTa ? 'கூட்டுத்தொகை' : 'Subtotal'}</span>
                        <b className="tabular-nums">{formatMoney(invoice.subtotal)}</b>
                      </div>
                      {(invoice.discount ?? 0) > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#15803d' }}>
                          <span>{isTa ? 'தள்ளுபடி' : 'Discount'}</span>
                          <b className="tabular-nums">-{formatMoney(invoice.discount)}</b>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 900, borderTop: '1.5px solid #0f172a', paddingTop: 6 }}>
                        <span>{isTa ? 'மொத்த பில் தொகை' : 'Invoice Total'}</span>
                        <span className="tabular-nums">{formatMoney(total)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{isTa ? 'பெற்ற தொகை' : 'Amount Tendered'}</span>
                        <b className="tabular-nums">{formatMoney(invoice.cash_received ?? invoice.amount_paid)}</b>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#15803d' }}>
                        <span>{isTa ? 'பில்லுக்கு செலுத்தியது' : 'Applied to Invoice'}</span>
                        <b className="tabular-nums">{formatMoney(invoice.applied_to_bill)}</b>
                      </div>
                      {invoice.applied_to_old_debt > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#15803d' }}>
                          <span>{isTa ? 'பழைய கடனுக்கு வரவு' : 'Applied to Old Debt'}</span>
                          <b className="tabular-nums">{formatMoney(invoice.applied_to_old_debt)}</b>
                        </div>
                      )}
                      {(invoice.change_returned ?? 0) > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{isTa ? 'மீதிப் பணம்' : 'Change Returned'}</span>
                          <b className="tabular-nums">{formatMoney(invoice.change_returned)}</b>
                        </div>
                      )}
                      {invoice.balance_due > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#b45309', fontWeight: 800 }}>
                          <span>{isTa ? 'இந்த பில் பாக்கி' : 'Invoice Due'}</span>
                          <b className="tabular-nums">{formatMoney(invoice.balance_due)}</b>
                        </div>
                      )}
                      {invoice.customer_balance !== undefined && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #cbd5e1', paddingTop: 5, fontWeight: 900 }}>
                          <span>{isTa ? 'புதிய கணக்கு பாக்கி' : 'Resulting Account Balance'}</span>
                          <span className="tabular-nums">{formatMoney(invoice.customer_balance)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              </div>
            </div>
          ) : (
            <article
              className="thermal-receipt"
              style={{
                width: '76mm',
                margin: '0 auto',
                padding: '12px',
                background: '#fff',
                border: '1px dashed #cbd5e1',
                borderRadius: 8,
                fontSize: 12,
                color: '#0f172a',
              }}
            >
              {isCanceled && (
                <div style={{ textAlign: 'center', fontWeight: 900, color: '#b91c1c', border: '1.5px solid #dc2626', padding: 4, marginBottom: 8 }}>
                  {isTa ? 'ரத்து செய்யப்பட்ட பில் (CANCELED)' : 'CANCELED INVOICE'}
                </div>
              )}
              <div style={{ textAlign: 'center', borderBottom: '1px dashed #94a3b8', paddingBottom: 8, marginBottom: 8 }}>
                {shopName && <div style={{ fontSize: 15, fontWeight: 900 }}>{shopName}</div>}
                {shopAddress && <div style={{ fontSize: 11 }}>{shopAddress}</div>}
                {shopPhone && <div style={{ fontSize: 11 }}>{shopPhone}</div>}
                {shopTaxId && <div style={{ fontSize: 11 }}>{shopTaxId}</div>}
              </div>

              <div style={{ display: 'grid', gap: 3, borderBottom: '1px dashed #94a3b8', paddingBottom: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{isTa ? 'பில் எண்:' : 'Bill No:'}</span>
                  <b>{invoice.invoice_number}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{isTa ? 'தேதி:' : 'Date:'}</span>
                  <span>{invoice.date}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{isTa ? 'வாடிக்கையாளர்:' : 'Customer:'}</span>
                  <b>{customerName}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{isTa ? 'பணியாளர்:' : 'Staff:'}</span>
                  <span>{invoice.staff_name}</span>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 6, borderBottom: '1px dashed #94a3b8', paddingBottom: 8, marginBottom: 8 }}>
                {invoice.items.map((item) => (
                  <div key={String(item.id)}>
                    <div style={{ fontWeight: 800 }}>
                      {isTa && item.ta ? item.ta : item.name} ({item.unit})
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#334155' }}>
                      <span>
                        {item.quantity} × {formatMoney(item.price)}
                      </span>
                      <b className="tabular-nums">{formatMoney(item.subtotal)}</b>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{isTa ? 'கூட்டுத்தொகை' : 'Subtotal'}</span>
                  <span className="tabular-nums">{formatMoney(invoice.subtotal)}</span>
                </div>
                {(invoice.discount ?? 0) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{isTa ? 'தள்ளுபடி' : 'Discount'}</span>
                    <span className="tabular-nums">-{formatMoney(invoice.discount)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 900, fontSize: 14, borderTop: '1px solid #0f172a', paddingTop: 4 }}>
                  <span>{isTa ? 'மொத்தம்' : 'Total'}</span>
                  <span className="tabular-nums">{formatMoney(total)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{isTa ? 'செலுத்தியது' : 'Paid'}</span>
                  <b className="tabular-nums">{formatMoney(invoice.applied_to_bill)}</b>
                </div>
                {invoice.applied_to_old_debt > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{isTa ? 'பழைய கடனுக்கு' : 'Old Debt Paid'}</span>
                    <b className="tabular-nums">{formatMoney(invoice.applied_to_old_debt)}</b>
                  </div>
                )}
                {(invoice.change_returned ?? 0) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{isTa ? 'மீதிப் பணம்' : 'Change'}</span>
                    <b className="tabular-nums">{formatMoney(invoice.change_returned)}</b>
                  </div>
                )}
                {invoice.customer_balance !== undefined && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, borderTop: '1px dashed #94a3b8', paddingTop: 4 }}>
                    <span>{isTa ? 'புதிய பாக்கி' : 'Balance'}</span>
                    <span className="tabular-nums">{formatMoney(invoice.customer_balance)}</span>
                  </div>
                )}
              </div>
            </article>
          )}
        </div>

        <div className="modal-actions no-print" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          {onRetry ? (
            <button type="button" className="btn-cancel" onClick={onRetry} style={{ padding: '10px 14px' }}>
              <Icon name="refresh" size={15} /> {lang === 'ta' ? 'புதுப்பி' : 'Refresh'}
            </button>
          ) : (
            <span />
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-cancel" onClick={onClose} style={{ padding: '10px 16px' }}>
              {lang === 'ta' ? 'மூடு' : 'Close'}
            </button>
            <button
              type="button"
              className="btn-modify-large"
              disabled={downloading}
              onClick={handleDownloadPdf}
              style={{ background: '#0f172a' }}
            >
              <Icon name="download" size={16} />
              <span>{downloading ? '...' : lang === 'ta' ? 'PDF பதிவிறக்கு' : 'Download PDF'}</span>
            </button>
            <button type="button" className="btn-modify-large" onClick={handlePrint}>
              <Icon name="print" size={16} />
              <span>{lang === 'ta' ? 'அச்சிடு' : 'Print'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
