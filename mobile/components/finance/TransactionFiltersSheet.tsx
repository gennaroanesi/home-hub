// The Transactions screen's filters and sort, in one sheet: custom dates,
// sort, direction, needs-a-category, whose budget, and any number of
// accounts, categories and contributors (list_finance_transactions).
// Edits a draft; Done applies it, Reset clears it.

import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { CategorySheet, DateField, ff } from "./form";
import { ACCENT, Chip, WARN, fs } from "./ui";

import { TX_SORTS, TX_SORT_LABELS, type TxSort } from "../../../lib/finance/tx-filter";

export type { TxSort };

export type TxFilters = {
  /** null = the month picked on the screen. */
  custom: { from: string; to: string } | null;
  sort: TxSort;
  direction: "" | "in" | "out" | "spending";
  uncategorized: boolean;
  /** "" = every budget; household or a person id. */
  ledger: string;
  accountIds: string[];
  categories: string[];
  personIds: string[];
};

export const NO_FILTERS: TxFilters = { custom: null, sort: "newest", direction: "", uncategorized: false, ledger: "", accountIds: [], categories: [], personIds: [] };

export const SORT_LABELS = TX_SORT_LABELS;

/** How many filters differ from none (sort and dates not counted). */
export function activeFilterCount(f: TxFilters): number {
  return f.accountIds.length + f.categories.length + f.personIds.length + (f.direction ? 1 : 0) + (f.uncategorized ? 1 : 0) + (f.ledger ? 1 : 0);
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function TransactionFiltersSheet({
  visible,
  value,
  accounts,
  people,
  ledgers,
  defaultRange,
  onApply,
  onClose,
}: {
  visible: boolean;
  value: TxFilters;
  accounts: Array<{ id: string; name: string }>;
  /** Contributors: the household. */
  people: Array<{ id: string; name: string }>;
  /** Budgets to pick from: household and each person with one. */
  ledgers: Array<{ key: string; name: string }>;
  /** Where custom dates start when first switched on. */
  defaultRange: { from: string; to: string };
  onApply: (f: TxFilters) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<TxFilters>(value);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (visible) setD(value);
  }, [visible, value]);
  const set = (patch: Partial<TxFilters>) => setD({ ...d, ...patch });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ff.screen}>
        <View style={ff.header}>
          <Pressable onPress={() => setD({ ...NO_FILTERS })} hitSlop={8}>
            <Text style={ff.cancel}>Reset</Text>
          </Pressable>
          <Text style={ff.headerTitle}>Filters</Text>
          <Pressable onPress={() => onApply(d)} hitSlop={8}>
            <Text style={ff.save}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={ff.body}>
          <Section label="Sort">
            {TX_SORTS.map((k) => (
              <Chip key={k} label={SORT_LABELS[k]} on={d.sort === k} onPress={() => set({ sort: k })} />
            ))}
          </Section>

          <Section label="Dates">
            <Chip label="The month on screen" on={!d.custom} onPress={() => set({ custom: null })} />
            <Chip label="Custom" on={!!d.custom} onPress={() => set({ custom: d.custom ?? defaultRange })} />
          </Section>
          {d.custom && (
            <View style={{ gap: 8, marginTop: -6 }}>
              <Text style={fs.muted}>From</Text>
              <DateField value={d.custom.from} onChange={(from) => from && set({ custom: { ...d.custom!, from } })} />
              <Text style={fs.muted}>To</Text>
              <DateField value={d.custom.to} onChange={(to) => to && set({ custom: { ...d.custom!, to } })} />
            </View>
          )}

          <Section label="Show">
            <Chip label="In and out" on={!d.direction} onPress={() => set({ direction: "" })} />
            <Chip label="Money in" on={d.direction === "in"} onPress={() => set({ direction: "in" })} />
            <Chip label="Money out" on={d.direction === "out"} onPress={() => set({ direction: "out" })} />
            <Chip label="Spending" on={d.direction === "spending"} onPress={() => set({ direction: "spending" })} />
            <Chip label="Needs category" on={d.uncategorized} color={WARN} onPress={() => set({ uncategorized: !d.uncategorized })} />
          </Section>

          {ledgers.length > 1 && (
            <Section label="Counts in">
              <Chip label="Any budget" on={!d.ledger} onPress={() => set({ ledger: "" })} />
              {ledgers.map((l) => (
                <Chip key={l.key} label={l.name} on={d.ledger === l.key} onPress={() => set({ ledger: d.ledger === l.key ? "" : l.key })} />
              ))}
            </Section>
          )}

          <Section label={`Accounts${d.accountIds.length ? ` · ${d.accountIds.length}` : ""}`}>
            {accounts.map((a) => (
              <Chip key={a.id} label={a.name} on={d.accountIds.includes(a.id)} onPress={() => set({ accountIds: toggle(d.accountIds, a.id) })} />
            ))}
          </Section>

          <Section label={`Categories${d.categories.length ? ` · ${d.categories.length}` : ""}`}>
            {d.categories.map((c) => (
              <Chip key={c} label={`${c} ✕`} on onPress={() => set({ categories: d.categories.filter((x) => x !== c) })} />
            ))}
            <Pressable onPress={() => setPicking(true)} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6 }} hitSlop={6}>
              <Ionicons name="add" size={16} color={ACCENT} />
              <Text style={{ color: ACCENT }}>Add category</Text>
            </Pressable>
          </Section>
          <Text style={[fs.muted, { marginTop: -8 }]}>A parent category includes its sub-categories (Baby → Baby: Furniture).</Text>

          {people.length > 0 && (
            <Section label={`Contributors (money in)${d.personIds.length ? ` · ${d.personIds.length}` : ""}`}>
              {people.map((p) => (
                <Chip key={p.id} label={p.name} on={d.personIds.includes(p.id)} onPress={() => set({ personIds: toggle(d.personIds, p.id) })} />
              ))}
            </Section>
          )}
        </ScrollView>
      </View>
      <CategorySheet
        visible={picking}
        value=""
        allowClear={false}
        onClose={() => setPicking(false)}
        onPick={(c) => {
          setPicking(false);
          if (c && !d.categories.includes(c)) set({ categories: [...d.categories, c] });
        }}
      />
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={ff.label}>{label}</Text>
      <View style={fs.chipRow}>{children}</View>
    </View>
  );
}
