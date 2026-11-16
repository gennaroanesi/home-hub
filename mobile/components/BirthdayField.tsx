// Birthday picker for people (Contacts, Household): a field showing the
// date that opens the native spinner, with a clear button. Stored as
// YYYY-MM-DD; year 1900 means "year unknown" (lib/people.ts birthdayLabel).

import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";

function isoDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function label(s: string): string {
  const d = parseIso(s);
  if (!d) return s;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() > 1900 ? { year: "numeric" } : {}),
  });
}

export function BirthdayField({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.dateBtn} disabled={disabled}>
        <Text style={[styles.dateBtnText, !value && styles.placeholder]}>
          {value ? label(value) : "Pick a date"}
        </Text>
        {!!value && (
          <Pressable onPress={() => onChange("")} hitSlop={8} disabled={disabled}>
            <Ionicons name="close-circle" size={18} color="#bbb" />
          </Pressable>
        )}
      </Pressable>
      {open && (
        <View style={styles.spinnerCard}>
          <DateTimePicker
            value={parseIso(value) ?? new Date(1990, 0, 1)}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            themeVariant="light"
            minimumDate={new Date(1900, 0, 1)}
            maximumDate={new Date()}
            onChange={(_, picked) => {
              if (Platform.OS !== "ios") setOpen(false);
              if (picked) onChange(isoDateOf(picked));
            }}
          />
        </View>
      )}
      <Text style={styles.hint}>Shows in the week planner. Unknown year: use 1900.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  },
  dateBtnText: { fontSize: 15, color: "#222" },
  placeholder: { color: "#888" },
  spinnerCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
    paddingVertical: 4,
  },
  hint: { fontSize: 12, color: "#999", marginTop: 4 },
});
