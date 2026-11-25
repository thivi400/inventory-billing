import type {
  ProductVariant,
  StarterSlotBinding,
  StarterSlotDefinition,
  StarterSlotKey,
  StarterSlotResolution,
} from './types.ts';

/**
 * Exact six starter cards in the mandatory order defined in docs/SPEC.md (Phase 1A).
 */
export const STARTER_SLOTS: StarterSlotDefinition[] = [
  {
    slotKey: '500ML',
    labelEn: '500 ml',
    labelTa: '500 மி.லி',
    canonicalSku: 'SKU-500ML',
    legacySkuAliases: ['500ML', 'SKU-500', 'SKU-WAT-500'],
    acceptedNamesEn: ['500 ml Water', '500ml Water', '500 ml', '500ml'],
    soldBy: 'bottle',
    defaultNameEn: '500 ml Water',
    defaultNameTa: '500 மி.லி தண்ணீர்',
    defaultReturnable: false,
  },
  {
    slotKey: '1L',
    labelEn: '1 L',
    labelTa: '1 லிட்டர்',
    canonicalSku: 'SKU-1L',
    legacySkuAliases: ['1L', 'SKU-WAT-1L'],
    acceptedNamesEn: ['1 L Water', '1L Water', '1 L', '1L'],
    soldBy: 'bottle',
    defaultNameEn: '1 L Water',
    defaultNameTa: '1 லிட்டர் தண்ணீர்',
    defaultReturnable: false,
  },
  {
    slotKey: '1.5L',
    labelEn: '1.5 L',
    labelTa: '1.5 லிட்டர்',
    canonicalSku: 'SKU-1.5L',
    legacySkuAliases: ['1.5L', 'SKU-WAT-1.5L'],
    acceptedNamesEn: ['1.5 L Water', '1.5L Water', '1.5 L', '1.5L'],
    soldBy: 'bottle',
    defaultNameEn: '1.5 L Water',
    defaultNameTa: '1.5 லிட்டர் தண்ணீர்',
    defaultReturnable: false,
  },
  {
    slotKey: '5L',
    labelEn: '5 L',
    labelTa: '5 லிட்டர்',
    canonicalSku: 'SKU-5L',
    legacySkuAliases: ['5L', 'SKU-WAT-5L'],
    acceptedNamesEn: ['5 L Water', '5L Water', '5 L', '5L'],
    soldBy: 'can',
    defaultNameEn: '5 L Water',
    defaultNameTa: '5 லிட்டர் தண்ணீர்',
    defaultReturnable: false,
  },
  {
    slotKey: '19L_FILLED',
    labelEn: '19 L Filled',
    labelTa: '19 லிட்டர் நிரப்பியது',
    canonicalSku: 'SKU-19L',
    legacySkuAliases: ['19L', 'SKU-19L-FILLED', 'SKU-WAT-19L'],
    acceptedNamesEn: [
      '19 L Filled',
      '19 L Water (filled)',
      '19L Water (filled)',
      '19 L Water',
      '19L Water',
      '19 L',
      '19L',
    ],
    soldBy: 'can',
    defaultNameEn: '19 L Filled',
    defaultNameTa: '19 லிட்டர் நிரப்பிய கேன்',
    defaultReturnable: true,
  },
  {
    slotKey: '19L_EMPTY',
    labelEn: '19 L Empty Can',
    labelTa: '19 லிட்டர் காலி கேன்',
    canonicalSku: 'SKU-19L-EMPTY',
    legacySkuAliases: [],
    acceptedNamesEn: ['19 L Empty Can', '19 L Bottle (empty/new)'],
    soldBy: 'can',
    defaultNameEn: '19 L Empty Can',
    defaultNameTa: '19 லிட்டர் காலி கேன் (புதியது)',
    defaultReturnable: false,
  },
];

const KNOWN_20L_SKUS = new Set(['sku-test-can-20l', 'can-20l', 'sku-can-20l']);

export function normalizeText(val: string): string {
  return val.trim().toLowerCase();
}

export function isKnown20LProduct(variant: Pick<ProductVariant, 'sku' | 'nameEn'>): boolean {
  const sku = normalizeText(variant.sku);
  const name = normalizeText(variant.nameEn);
  if (KNOWN_20L_SKUS.has(sku)) return true;
  if (name === 'premium 20l can (new)') return true;
  if (/\b20\s*l\b/i.test(name) || /(^|[-_])20l($|[-_])/i.test(sku)) return true;
  return false;
}

export function isForbiddenBinding(
  slotKey: StarterSlotKey,
  variant: Pick<ProductVariant, 'sku' | 'nameEn'>
): boolean {
  if ((slotKey === '19L_FILLED' || slotKey === '19L_EMPTY') && isKnown20LProduct(variant)) {
    return true;
  }
  return false;
}

/**
 * Deterministic, exact starter slot resolver matching docs/SPEC.md Phase 1A rules:
 * 1. Explicit owner/manager binding (unless forbidden 20L on 19L slot)
 * 2. Canonical SKU match (case-insensitive, trimmed)
 * 3. Legacy SKU aliases in priority order
 * 4. Exact English name match ONLY if it identifies one active variant
 * Never matches by substring, size alone, sort order, or array position.
 * Checks accepted English names AND sold_by unit for conflicts.
 */
export function resolveStarterSlots(
  variants: ProductVariant[],
  bindings: StarterSlotBinding[]
): {
  slots: StarterSlotResolution[];
  otherActiveProducts: ProductVariant[];
  archivedProducts: ProductVariant[];
} {
  const bindingMap = new Map<StarterSlotKey, StarterSlotBinding>();
  for (const b of bindings) {
    bindingMap.set(b.slotKey, b);
  }

  const assignedTypeIds = new Set<string>();
  const slots: StarterSlotResolution[] = [];

  for (const def of STARTER_SLOTS) {
    const binding = bindingMap.get(def.slotKey);
    const excluded = new Set(binding?.excludedTypeIds ?? []);
    const acceptedNames = new Set(def.acceptedNamesEn.map(normalizeText));

    // 1. Explicit binding by type_id
    if (binding?.productTypeId) {
      const bound = variants.find((v) => v.typeId === binding.productTypeId);
      if (bound && !isForbiddenBinding(def.slotKey, bound)) {
        if (bound.isArchived) {
          slots.push({
            definition: def,
            status: 'archived',
            variant: bound,
            candidates: [bound],
            conflictReason: null,
          });
        } else {
          assignedTypeIds.add(bound.typeId);
          slots.push({
            definition: def,
            status: 'matched',
            variant: bound,
            candidates: [bound],
            conflictReason: null,
          });
        }
        continue;
      }
    }

    const eligible = variants.filter(
      (v) => !excluded.has(v.typeId) && !isForbiddenBinding(def.slotKey, v)
    );

    // Helper to evaluate a candidate list from SKU matching
    const evaluateSkuMatches = (matches: ProductVariant[]): StarterSlotResolution | null => {
      if (matches.length === 0) return null;
      const activeMatches = matches.filter((m) => !m.isArchived);
      const archivedMatches = matches.filter((m) => m.isArchived);

      if (activeMatches.length > 1) {
        return {
          definition: def,
          status: 'ambiguous',
          variant: null,
          candidates: activeMatches,
          conflictReason: `Multiple active products share matching SKU for ${def.labelEn}.`,
        };
      }

      if (activeMatches.length === 1) {
        const match = activeMatches[0];
        const nameOk = acceptedNames.has(normalizeText(match.nameEn));
        const unitOk = normalizeText(match.soldBy) === normalizeText(def.soldBy);
        if (!nameOk || !unitOk) {
          const reasons: string[] = [];
          if (!nameOk) reasons.push(`name "${match.nameEn}" is not an accepted ${def.labelEn} name`);
          if (!unitOk) reasons.push(`sold by "${match.soldBy}" instead of "${def.soldBy}"`);
          return {
            definition: def,
            status: 'conflict',
            variant: match,
            candidates: [match],
            conflictReason: `Catalog conflict: ${reasons.join(' and ')}.`,
          };
        }
        assignedTypeIds.add(match.typeId);
        return {
          definition: def,
          status: 'matched',
          variant: match,
          candidates: [match],
          conflictReason: null,
        };
      }

      // Only archived matches exist
      if (archivedMatches.length === 1) {
        return {
          definition: def,
          status: 'archived',
          variant: archivedMatches[0],
          candidates: archivedMatches,
          conflictReason: null,
        };
      }
      return {
        definition: def,
        status: 'ambiguous',
        variant: null,
        candidates: archivedMatches,
        conflictReason: `Multiple archived products match ${def.labelEn}.`,
      };
    };

    // 2. Canonical SKU match
    const canonTarget = normalizeText(def.canonicalSku);
    const canonMatches = eligible.filter((v) => normalizeText(v.sku) === canonTarget);
    const canonRes = evaluateSkuMatches(canonMatches);
    if (canonRes) {
      slots.push(canonRes);
      continue;
    }

    // 3. Legacy SKU aliases in priority order
    let aliasRes: StarterSlotResolution | null = null;
    for (const alias of def.legacySkuAliases) {
      const aliasTarget = normalizeText(alias);
      const aliasMatches = eligible.filter((v) => normalizeText(v.sku) === aliasTarget);
      aliasRes = evaluateSkuMatches(aliasMatches);
      if (aliasRes) break;
    }
    if (aliasRes) {
      slots.push(aliasRes);
      continue;
    }

    // 4. Exact English name match ONLY if it identifies one active variant (also check unit!)
    const activeNameMatches = eligible.filter(
      (v) => !v.isArchived && acceptedNames.has(normalizeText(v.nameEn))
    );
    if (activeNameMatches.length > 1) {
      slots.push({
        definition: def,
        status: 'ambiguous',
        variant: null,
        candidates: activeNameMatches,
        conflictReason: `Multiple active products have exact ${def.labelEn} names.`,
      });
      continue;
    }
    if (activeNameMatches.length === 1) {
      const match = activeNameMatches[0];
      const unitOk = normalizeText(match.soldBy) === normalizeText(def.soldBy);
      if (!unitOk) {
        slots.push({
          definition: def,
          status: 'conflict',
          variant: match,
          candidates: [match],
          conflictReason: `Catalog conflict: "${match.nameEn}" is sold by "${match.soldBy}" instead of "${def.soldBy}".`,
        });
        continue;
      }
      assignedTypeIds.add(match.typeId);
      slots.push({
        definition: def,
        status: 'matched',
        variant: match,
        candidates: [match],
        conflictReason: null,
      });
      continue;
    }

    // Check if an archived exact-name match exists
    const archivedNameMatches = eligible.filter(
      (v) => v.isArchived && acceptedNames.has(normalizeText(v.nameEn))
    );
    if (archivedNameMatches.length === 1) {
      slots.push({
        definition: def,
        status: 'archived',
        variant: archivedNameMatches[0],
        candidates: archivedNameMatches,
        conflictReason: null,
      });
      continue;
    }

    // 5. Missing
    slots.push({
      definition: def,
      status: 'missing',
      variant: null,
      candidates: [],
      conflictReason: null,
    });
  }

  // Extras: any active product not matched to one of the 6 starter slots
  const otherActiveProducts = variants.filter(
    (v) => !v.isArchived && !assignedTypeIds.has(v.typeId)
  );
  const archivedProducts = variants.filter((v) => v.isArchived);

  return { slots, otherActiveProducts, archivedProducts };
}
