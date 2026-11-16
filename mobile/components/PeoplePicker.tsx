// Picks people from the household and the contact book — the native
// twin of components/people-picker.tsx on the web. A pressable field
// shows the selected names; tapping it opens a sheet grouped Household,
// then Family, Friends, Work, Other (lib/people.ts pickerSections),
// searchable by name, a checkbox on every row. `single` picks one and
// closes; otherwise rows toggle and Done closes.
//
// PeoplePickerSheet is the sheet on its own, for screens that open it
// from an action rather than a field (reminders).

import { useMemo, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { pickerSections, type PickerPerson } from "../lib/people";
import { resizedImageUrl } from "../lib/image";

export type PeoplePickerPerson = PickerPerson & {
  emoji?: string | null;
  color?: string | null;
  photoKey?: string | null;
};

const ACCENT = "#735f55";

interface SheetProps<P extends PeoplePickerPerson> {
  visible: boolean;
  people: P[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  single?: boolean;
  /** Single mode: tapping the picked person keeps them instead of unselecting. */
  required?: boolean;
  title?: string;
}

export function PeoplePickerSheet<P extends PeoplePickerPerson>({
  visible,
  people,
  selectedIds,
  onChange,
  onClose,
  single = false,
  required = false,
  title,
}: SheetProps<P>) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const sections = useMemo(
    () => pickerSections(people, query).map((s) => ({ key: s.key, title: s.label, data: s.people })),
    [people, query]
  );

  function close() {
    setQuery("");
    onClose();
  }

  function toggle(id: string) {
    if (single) {
      onChange(selected.has(id) && !required ? [] : [id]);
      close();
      return;
    }
    onChange(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  }

  const count = selectedIds.filter((id) => people.some((p) => p.id === id)).length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <View style={styles.headerSide}>
            {single ? (
              <Pressable onPress={close} hitSlop={8}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            ) : count > 0 ? (
              <Pressable onPress={() => onChange([])} hitSlop={8}>
                <Text style={styles.cancel}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.headerMid}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {title ?? (single ? "Pick someone" : "Pick people")}
            </Text>
            {!single && (
              <Text style={styles.headerSub}>
                {count ? `${count} selected` : "Nobody selected"}
              </Text>
            )}
          </View>
          <View style={[styles.headerSide, styles.headerRight]}>
            {!single && (
              <Pressable onPress={close} hitSlop={8}>
                <Text style={styles.done}>Done</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.searchWrap}>
          <Ionicons name="search" size={15} color="#999" />
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search people"
            placeholderTextColor="#999"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>

        <SectionList
          sections={sections}
          keyExtractor={(p) => p.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          stickySectionHeadersEnabled
          contentContainerStyle={styles.listBody}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <Pressable
                onPress={() => toggle(item.id)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={item.name}
              >
                <View style={[styles.check, on && styles.checkOn]}>
                  {on && <Ionicons name="checkmark" size={14} color="#fff" />}
                </View>
                <PersonAvatar person={item} size={30} />
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {query.trim() ? `No one matches “${query.trim()}”.` : "No one to pick."}
            </Text>
          }
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

interface FieldProps<P extends PeoplePickerPerson> {
  people: P[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  required?: boolean;
  /** Shown in the field when nobody is picked (e.g. "Household"). */
  placeholder?: string;
  /** Sheet title. */
  title?: string;
  disabled?: boolean;
}

export function PeoplePicker<P extends PeoplePickerPerson>({
  people,
  selectedIds,
  onChange,
  single = false,
  required = false,
  placeholder,
  title,
  disabled = false,
}: FieldProps<P>) {
  const [open, setOpen] = useState(false);
  const names = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p.name]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .join(", ");
  }, [people, selectedIds]);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        style={({ pressed }) => [
          styles.field,
          pressed && styles.rowPressed,
          disabled && styles.disabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel={title}
      >
        <Text style={[styles.fieldText, !names && styles.fieldPlaceholder]} numberOfLines={2}>
          {names || placeholder || (single ? "Pick someone" : "Nobody")}
        </Text>
        <Ionicons name="chevron-down" size={14} color="#999" />
      </Pressable>
      <PeoplePickerSheet
        visible={open}
        people={people}
        selectedIds={selectedIds}
        onChange={onChange}
        onClose={() => setOpen(false)}
        single={single}
        required={required}
        title={title}
      />
    </>
  );
}

export function PersonAvatar({
  person,
  size = 30,
}: {
  person: { name: string; color?: string | null; emoji?: string | null; photoKey?: string | null };
  size?: number;
}) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (person.photoKey) {
    return (
      <Image
        source={{ uri: resizedImageUrl(person.photoKey, size * 3) }}
        style={[round, styles.avatarPhoto]}
        accessibilityLabel={person.name}
      />
    );
  }
  return (
    <View style={[round, styles.avatar, { backgroundColor: person.color ?? "#3a5068" }]}>
      <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.45) }]}>
        {person.emoji || person.name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    backgroundColor: "#fff",
  },
  headerSide: { width: 70 },
  headerRight: { alignItems: "flex-end" },
  headerMid: { flex: 1, alignItems: "center" },
  headerTitle: { fontSize: 16, fontWeight: "600" },
  headerSub: { fontSize: 12, color: "#888", marginTop: 2 },
  cancel: { color: "#888", fontSize: 15 },
  done: { color: ACCENT, fontWeight: "600", fontSize: 15 },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 12,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  search: { flex: 1, paddingVertical: 10, fontSize: 15, color: "#222" },

  listBody: { paddingBottom: 40 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    backgroundColor: "#f7f7f7",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowPressed: { opacity: 0.6 },
  rowName: { flex: 1, fontSize: 15, color: "#222" },
  check: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: "#ccc",
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  avatar: { alignItems: "center", justifyContent: "center" },
  avatarPhoto: { backgroundColor: "#eee" },
  avatarText: { color: "#fff", fontWeight: "500" },
  empty: { color: "#888", padding: 24, textAlign: "center", fontSize: 14 },

  field: {
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
  fieldText: { flex: 1, fontSize: 15, color: "#222" },
  fieldPlaceholder: { color: "#888" },
  disabled: { opacity: 0.4 },
});
