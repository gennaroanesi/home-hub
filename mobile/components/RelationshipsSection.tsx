// The relationships block of a person's screen (Contacts detail, Household
// edit): who's related to them and how, unlink, and a row to add one
// ("Eva is Priscilla's child, daughter"). The native twin of
// RelationshipsEditor in components/people.tsx. Saves immediately through
// the save_relationship op Janet and the web use; one link per pair, so
// linking an already-linked pair replaces it. The inverse is derived
// (lib/relationships.ts), never stored.

import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../lib/ops";
import { PeoplePicker, type PeoplePickerPerson } from "./PeoplePicker";
import {
  RELATION_KINDS,
  RELATION_LABELS,
  relationsOf,
  type RelationKind,
  type RelationshipRow,
} from "../../lib/relationships";

const ACCENT = "#735f55";

interface Props {
  person: { id: string; name: string };
  /** Everyone (household and contacts), to name the other side and to pick from. */
  people: PeoplePickerPerson[];
  rels: RelationshipRow[];
  onChanged: () => void | Promise<void>;
  disabled?: boolean;
}

export function RelationshipsSection({ person, people, rels, onChanged, disabled = false }: Props) {
  const [otherId, setOtherId] = useState("");
  const [kind, setKind] = useState<RelationKind | "">("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);

  const byId = new Map(people.map((p) => [p.id, p]));
  const current = relationsOf(person.id, rels).filter((r) => byId.has(r.otherPersonId));

  async function run(input: Parameters<typeof callOp<"save_relationship">>[1]): Promise<boolean> {
    setBusy(true);
    const r = await callOp("save_relationship", input);
    setBusy(false);
    if ("error" in r) {
      Alert.alert("Couldn't save", r.error);
      return false;
    }
    await onChanged();
    return true;
  }

  async function add() {
    if (!otherId || !kind) return;
    // "<other> is <person>'s <kind>", with the word for the other side.
    const ok = await run({
      personId: otherId,
      kind,
      relatedPersonId: person.id,
      label: word.trim() || null,
    });
    if (ok) {
      setOtherId("");
      setKind("");
      setWord("");
    }
  }

  function unlink(otherPersonId: string, otherName: string) {
    Alert.alert(`Unlink ${otherName}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unlink",
        style: "destructive",
        onPress: () => void run({ personId: person.id, relatedPersonId: otherPersonId, remove: true }),
      },
    ]);
  }

  const off = disabled || busy;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Relationships</Text>
      <View style={styles.card}>
        {current.length === 0 && <Text style={styles.none}>None yet.</Text>}
        {current.map((r, i) => {
          const other = byId.get(r.otherPersonId)!;
          return (
            <View key={r.relationshipId} style={[styles.relRow, i < current.length - 1 && styles.divider]}>
              <Text style={styles.relText}>
                {other.name} <Text style={styles.relMuted}>is {person.name}&apos;s {r.role}</Text>
              </Text>
              <Pressable onPress={() => unlink(r.otherPersonId, other.name)} hitSlop={10} disabled={off}>
                <Ionicons name="close-circle" size={20} color="#bbb" />
              </Pressable>
            </View>
          );
        })}
      </View>

      <Text style={styles.subLabel}>Add a relationship</Text>
      <PeoplePicker
        single
        title="Who"
        placeholder="Who"
        people={people.filter((p) => p.id !== person.id)}
        selectedIds={otherId ? [otherId] : []}
        onChange={(ids) => setOtherId(ids[0] ?? "")}
        disabled={off}
      />
      <Text style={styles.hint}>is {person.name}&apos;s</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {RELATION_KINDS.map((k) => {
          const on = kind === k;
          return (
            <Pressable
              key={k}
              onPress={() => setKind(on ? "" : k)}
              style={[styles.chip, on && styles.chipOn]}
              disabled={off}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{RELATION_LABELS[k]}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <TextInput
        style={styles.input}
        value={word}
        onChangeText={setWord}
        placeholder="Word (optional), e.g. daughter"
        placeholderTextColor="#888"
        autoCapitalize="none"
        editable={!off}
      />
      <Pressable
        onPress={add}
        disabled={off || !otherId || !kind}
        style={[styles.addBtn, (off || !otherId || !kind) && styles.disabled]}
      >
        {busy ? (
          <ActivityIndicator size="small" />
        ) : (
          <>
            <Ionicons name="link-outline" size={16} color={ACCENT} />
            <Text style={styles.addBtnText}>Add relationship</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 12 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  subLabel: { fontSize: 13, color: "#666", marginTop: 4 },
  hint: { fontSize: 13, color: "#666" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  none: { color: "#888", fontSize: 14, padding: 12 },
  relRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee" },
  relText: { flex: 1, fontSize: 15, color: "#222" },
  relMuted: { color: "#888" },
  chipRow: { gap: 8, paddingVertical: 2 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  chipOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    alignSelf: "flex-end",
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    minWidth: 150,
  },
  addBtnText: { color: ACCENT, fontWeight: "500", fontSize: 14 },
  disabled: { opacity: 0.4 },
});
