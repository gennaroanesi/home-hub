// Form pieces for the finance sheets (transaction, scheduled, goal,
// budget line): the page-sheet frame with Cancel / Save, labelled inputs,
// a date field with the native picker, a category picker over
// list_finance_categories (free text allowed), and a household-person picker.

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";

import { callOp } from "../../lib/ops";
import { fmtDate } from "../../../lib/finance/dates";
import { normalizeCategoryName, SUBCATEGORY_SEPARATOR } from "../../../lib/finance/categories";
import { categoryMatches } from "../../../lib/inventory";
import { ACCENT, Chip, fs } from "./ui";

export function FormSheet({
  visible,
  title,
  onClose,
  onSave,
  busy,
  canSave = true,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSave: () => void;
  busy?: boolean;
  canSave?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={ff.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={ff.header}>
          <Pressable onPress={onClose} disabled={busy} hitSlop={8}>
            <Text style={ff.cancel}>Cancel</Text>
          </Pressable>
          <Text style={ff.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={onSave} disabled={busy || !canSave} hitSlop={8}>
            {busy ? <ActivityIndicator /> : <Text style={[ff.save, !canSave && ff.disabled]}>Save</Text>}
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={ff.body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={ff.field}>
      <Text style={ff.label}>{label}</Text>
      {children}
      {hint ? <Text style={ff.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor="#999" {...props} style={[ff.input, props.multiline && ff.multiline, props.style]} />;
}

/** Positive money amount as typed ("12.5"); strips anything but digits and one dot. */
export function cleanAmount(v: string): string {
  const c = v.replace(/[^0-9.]/g, "");
  const [a, ...rest] = c.split(".");
  return rest.length ? `${a}.${rest.join("").slice(0, 2)}` : a;
}

function parseIso(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** YYYY-MM-DD with the native picker; `clearable` adds an ✕ to empty it. */
export function DateField({ value, onChange, placeholder = "Pick a date", clearable }: { value: string; onChange: (v: string) => void; placeholder?: string; clearable?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen((v) => !v)} style={ff.dateBtn}>
        <Text style={[ff.dateText, !value && ff.placeholder]}>{value ? fmtDate(value, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : placeholder}</Text>
        {clearable && value ? (
          <Pressable onPress={() => onChange("")} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color="#bbb" />
          </Pressable>
        ) : null}
      </Pressable>
      {open && (
        <View style={ff.spinnerCard}>
          <DateTimePicker
            value={parseIso(value) ?? new Date()}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            themeVariant="light"
            onChange={(_, picked) => {
              if (Platform.OS !== "ios") setOpen(false);
              if (picked) onChange(isoOf(picked));
            }}
          />
        </View>
      )}
    </>
  );
}

let categoriesCache: string[] | null = null;

/** Drop the cached names (a new category was just saved on a budget line or a transaction). */
export function forgetFinanceCategories() {
  categoriesCache = null;
}

/** Category names in use (rules, budgets, created ones: lib/finance/category-list.ts), cached for the session. */
export function useFinanceCategories(): string[] {
  const [cats, setCats] = useState<string[]>(categoriesCache ?? []);
  useEffect(() => {
    if (categoriesCache) return;
    let live = true;
    void callOp("list_finance_categories", {}).then((r) => {
      if ("error" in r) return;
      categoriesCache = r.result.categories;
      if (live) setCats(r.result.categories);
    });
    return () => {
      live = false;
    };
  }, []);
  return cats;
}

/** A pressable field that opens a searchable category list; typing a new name is allowed. */
export function CategoryField({ value, onChange, placeholder = "Uncategorized" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={ff.dateBtn}>
        <Text style={[ff.dateText, !value && ff.placeholder]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color="#999" />
      </Pressable>
      <CategorySheet
        visible={open}
        value={value}
        onClose={() => setOpen(false)}
        onPick={(v) => {
          onChange(v);
          setOpen(false);
        }}
      />
    </>
  );
}

export function CategorySheet({ visible, value, onPick, onClose, allowClear = true }: { visible: boolean; value: string; onPick: (v: string) => void; onClose: () => void; allowClear?: boolean }) {
  const cats = useFinanceCategories();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (visible) setQ("");
  }, [visible]);
  // Tree order from list_finance_categories; search matches any words of
  // the path, like the inventory picker. "Parent > Child" creates a sub-category.
  const shown = useMemo(() => {
    const w = q.trim();
    return w ? cats.filter((c) => categoryMatches(c, w.replace(/:/g, " "))) : cats;
  }, [cats, q]);
  const typed = normalizeCategoryName(q);
  const exact = cats.some((c) => c.toLowerCase() === typed.toLowerCase());
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ff.screen}>
        <View style={ff.header}>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={ff.cancel}>Cancel</Text>
          </Pressable>
          <Text style={ff.headerTitle}>Category</Text>
          {allowClear ? (
            <Pressable onPress={() => onPick("")} hitSlop={8}>
              <Text style={ff.cancel}>Clear</Text>
            </Pressable>
          ) : (
            <View style={{ width: 40 }} />
          )}
        </View>
        <View style={{ padding: 12 }}>
          <Input value={q} onChangeText={setQ} placeholder="Search or type a new one" autoCorrect={false} autoFocus />
        </View>
        <FlatList
          data={shown}
          keyExtractor={(c) => c}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            typed && !exact ? (
              <Pressable onPress={() => onPick(typed)} style={ff.option}>
                <Ionicons name="add" size={18} color={ACCENT} />
                <Text style={[ff.optionText, { color: ACCENT }]}>Create “{typed}”</Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => {
            const parts = item.split(SUBCATEGORY_SEPARATOR);
            const searching = !!q.trim();
            return (
            <Pressable onPress={() => onPick(item)} style={({ pressed }) => [ff.option, pressed && fs.pressed, !searching && { paddingLeft: 16 + (parts.length - 1) * 18 }]}>
              <Text style={ff.optionText} numberOfLines={1}>
                {searching && parts.length > 1 ? <Text style={{ color: "#999" }}>{parts.slice(0, -1).join(SUBCATEGORY_SEPARATOR) + SUBCATEGORY_SEPARATOR}</Text> : null}
                {parts[parts.length - 1]}
              </Text>
              {item === value && <Ionicons name="checkmark" size={18} color={ACCENT} />}
            </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

/** Household (none) or one person, as chips: the finance ops' personId. */
export function PersonChips({ people, value, onChange, noneLabel = "Household" }: { people: Array<{ id: string; name: string }>; value: string; onChange: (id: string) => void; noneLabel?: string }) {
  return (
    <View style={fs.chipRow}>
      <Chip label={noneLabel} on={!value} onPress={() => onChange("")} />
      {people.map((p) => (
        <Chip key={p.id} label={p.name} on={value === p.id} onPress={() => onChange(p.id)} />
      ))}
    </View>
  );
}

export const ff = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    backgroundColor: "#fff",
    gap: 12,
  },
  headerTitle: { fontSize: 16, fontWeight: "600", flex: 1, textAlign: "center" },
  cancel: { color: "#888", fontSize: 15 },
  save: { color: ACCENT, fontWeight: "600", fontSize: 15 },
  disabled: { opacity: 0.4 },
  body: { padding: 20, gap: 14, paddingBottom: 60 },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "600", color: "#888", textTransform: "uppercase", letterSpacing: 0.5 },
  hint: { fontSize: 12, color: "#999" },
  input: { backgroundColor: "#fff", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd", color: "#222" },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  dateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    gap: 8,
  },
  dateText: { fontSize: 15, color: "#222", flex: 1 },
  placeholder: { color: "#999" },
  spinnerCard: { backgroundColor: "#fff", borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd", paddingVertical: 4 },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14, backgroundColor: "#fff", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee", gap: 8 },
  optionText: { fontSize: 15, color: "#222", flex: 1 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  box: { backgroundColor: "#fff", borderRadius: 10, padding: 12, gap: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: "#ddd" },
  smallBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: ACCENT },
  smallBtnText: { color: ACCENT, fontSize: 13, fontWeight: "600" },
  dangerBtn: { alignSelf: "center", paddingVertical: 10 },
  dangerText: { color: "#c0392b", fontSize: 15, fontWeight: "500" },
});
