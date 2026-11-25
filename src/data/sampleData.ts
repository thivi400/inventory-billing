import type { Product } from '../types';
import { isForbiddenBinding, STARTER_SLOTS } from '../shared/starterCatalog';

/**
 * Classifies active catalog items into canonical 6-slot order (1..6) for Sale/Billing,
 * while strictly keeping 20L cans and non-canonical extras after the 6 slots (rank 99).
 */
export function classifyProductRank(p: Partial<Product>): number {
  const sku = (p.sku || '').trim().toLowerCase();
  const name = (p.name || '').trim().toLowerCase();

  for (let i = 0; i < STARTER_SLOTS.length; i++) {
    const slot = STARTER_SLOTS[i];
    if (
      isForbiddenBinding(slot.slotKey, {
        sku: p.sku || '',
        nameEn: p.name || '',
      })
    ) {
      continue;
    }
    if (sku && (slot.canonicalSku.toLowerCase() === sku || slot.legacySkuAliases.some((s) => s.toLowerCase() === sku))) {
      return i + 1;
    }
    if (name && slot.acceptedNamesEn.some((n) => n.toLowerCase() === name)) {
      return i + 1;
    }
  }

  return 99;
}
