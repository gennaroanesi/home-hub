// Businesses and service people in the contact book (homeBusiness), plus
// health providers (homeHealthProvider), which live in their own model
// because visits point at them but are listed alongside.

export const BUSINESS_CATEGORIES = ["HOME", "AUTO", "PETS", "PERSONAL_CARE", "CHILDCARE", "FINANCE_LEGAL", "FOOD", "OTHER"] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export const BUSINESS_CATEGORY_LABELS: Record<BusinessCategory | "HEALTH", string> = {
  HOME: "Home & repairs",
  AUTO: "Auto",
  PETS: "Pets",
  PERSONAL_CARE: "Personal care",
  CHILDCARE: "Childcare",
  FINANCE_LEGAL: "Finance & legal",
  FOOD: "Food & drink",
  OTHER: "Other",
  HEALTH: "Health",
};

export function businessCategoryLabel(c: string | null | undefined): string | null {
  return c && c in BUSINESS_CATEGORY_LABELS ? BUSINESS_CATEGORY_LABELS[c as BusinessCategory] : null;
}

/** One row in the Businesses list, from either model. */
export interface BusinessRow {
  id: string;
  source: "business" | "health";
  name: string;
  category: string | null; // "HEALTH" for health providers
  service: string | null; // health: specialty
  contactName: string | null; // health: practice
  phone: string | null;
  email: string | null;
  website: string | null; // health: patient portal
  address: string | null;
  lastUsedOn: string | null;
  notes: string | null;
  active: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export function businessRow(b: Row): BusinessRow {
  return {
    id: b.id,
    source: "business",
    name: b.name,
    category: b.category ?? null,
    service: b.service ?? null,
    contactName: b.contactName ?? null,
    phone: b.phone ?? null,
    email: b.email ?? null,
    website: b.website ?? null,
    address: b.address ?? null,
    lastUsedOn: b.lastUsedOn ?? null,
    notes: b.notes ?? null,
    active: b.active !== false,
  };
}

export function healthProviderRow(p: Row): BusinessRow {
  const phones: Array<{ number?: string | null }> = typeof p.phones === "string" ? JSON.parse(p.phones) : (p.phones ?? []);
  return {
    id: p.id,
    source: "health",
    name: p.name,
    category: "HEALTH",
    service: p.specialty ?? null,
    contactName: p.practice ?? null,
    phone: phones.find((x) => x?.number)?.number ?? p.phone ?? null,
    email: null,
    website: p.portalUrl ?? null,
    address: p.address ?? null,
    lastUsedOn: null,
    notes: p.notes ?? null,
    active: p.active !== false,
  };
}

/** Every word appears somewhere in the row. */
export function businessMatches(b: BusinessRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [b.name, b.service, b.contactName, b.phone, b.email, b.notes, b.address, businessCategoryLabel(b.category)].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
