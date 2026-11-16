// Small form pieces shared by the Health sheets: a date field (YYYY-MM-DD),
// a date+time field (real-UTC ISO, picked in device-local time), a chip
// selector and the sheet header.

import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";

import { ACCENT, formStyles } from "../person-form-styles";

function ymdOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A YYYY-MM-DD date. Tapping opens the native picker; optional clear. */
export function DateField({
  value,
  onChange,
  placeholder = "Pick a date",
  clearable = false,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const d = parseYmd(value);
  return (
    <View>
      <Pressable
        onPress={() => {
          if (!open && !value) onChange(ymdOf(new Date()));
          setOpen((v) => !v);
        }}
        style={styles.dateBtn}
        disabled={disabled}
      >
        <Ionicons name="calendar-outline" size={16} color={ACCENT} />
        <Text style={[styles.dateBtnText, !d && styles.placeholder]}>
          {d
            ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
            : placeholder}
        </Text>
        {clearable && !!value && (
          <Pressable onPress={() => onChange("")} hitSlop={8} disabled={disabled}>
            <Ionicons name="close-circle" size={18} color="#bbb" />
          </Pressable>
        )}
      </Pressable>
      {open && (
        <View style={styles.spinnerCard}>
          <DateTimePicker
            value={d ?? new Date()}
            mode="date"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            themeVariant="light"
            onChange={(_, picked) => {
              if (Platform.OS !== "ios") setOpen(false);
              if (picked) onChange(ymdOf(picked));
            }}
          />
        </View>
      )}
    </View>
  );
}

/**
 * A moment in time (real UTC ISO, like calendar events). The spinner and
 * the label are in the phone's local time; the stored value is UTC.
 */
export function DateTimeField({
  value,
  onChange,
  placeholder = "Pick a date and time",
  disabled = false,
}: {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const d = value ? new Date(value) : null;
  return (
    <View>
      <Pressable
        onPress={() => {
          // The spinner only reports changes; start an empty field at its default.
          if (!open && !value) onChange(defaultVisitTime().toISOString());
          setOpen((v) => !v);
        }}
        style={styles.dateBtn}
        disabled={disabled}
      >
        <Ionicons name="time-outline" size={16} color={ACCENT} />
        <Text style={[styles.dateBtnText, !d && styles.placeholder]}>
          {d
            ? d.toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : placeholder}
        </Text>
      </Pressable>
      {open && (
        <View style={styles.spinnerCard}>
          <DateTimePicker
            value={d ?? defaultVisitTime()}
            mode="datetime"
            display="spinner"
            themeVariant="light"
            minuteInterval={5}
            onChange={(_, picked) => {
              if (picked) onChange(picked.toISOString());
            }}
          />
        </View>
      )}
    </View>
  );
}

/** Tomorrow 9:00 local — a sensible starting point for a new appointment. */
export function defaultVisitTime(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** Single-choice chips. `allowNone` lets a tap on the selected chip clear it. */
export function ChipSelect<K extends string>({
  options,
  value,
  onChange,
  allowNone = false,
  disabled = false,
}: {
  options: { key: K; label: string }[];
  value: K | "" | null;
  onChange: (k: K | "") => void;
  allowNone?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={formStyles.chipRow}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(on && allowNone ? "" : o.key)}
            style={[formStyles.chip, on && formStyles.chipOn]}
            disabled={disabled}
          >
            <Text style={[formStyles.chipText, on && formStyles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Cancel · Title · Save, the header every sheet uses. */
export function SheetHeader({
  title,
  onCancel,
  onSave,
  busy,
  canSave = true,
}: {
  title: string;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  canSave?: boolean;
}) {
  return (
    <View style={formStyles.header}>
      <Pressable onPress={onCancel} disabled={busy}>
        <Text style={formStyles.cancel}>Cancel</Text>
      </Pressable>
      <Text style={formStyles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <Pressable onPress={onSave} disabled={busy || !canSave}>
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Text style={[formStyles.save, !canSave && formStyles.disabled]}>Save</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  dateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  dateBtnText: { fontSize: 15, color: "#222", flex: 1 },
  placeholder: { color: "#888" },
  spinnerCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    marginTop: 6,
    paddingVertical: 4,
  },
});
