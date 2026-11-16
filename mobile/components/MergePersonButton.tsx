// "Merge into…" for admins — the native twin of the web MergeModal
// (components/people.tsx). Pick the person to keep with the people
// picker, confirm, then the admin-only mergePeople mutation rewrites
// every reference to `source` and deletes it. The result alert lists
// what was rewritten; `onMerged` then leaves the (now deleted) row.
// Copy and the summary come from lib/people-merge.ts, shared with web.

import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../lib/amplify";
import { PeoplePickerSheet, type PeoplePickerPerson } from "./PeoplePicker";
import {
  mergeCandidates,
  mergeConfirmBody,
  mergeConfirmTitle,
  mergeExplainer,
  mergeSummary,
} from "../../lib/people-merge";

type MergePerson = PeoplePickerPerson & { cognitoUsername?: string | null };

interface Props<P extends MergePerson> {
  source: P;
  people: P[];
  /** Called after a successful merge with the row that was kept. */
  onMerged: (target: P) => void;
  disabled?: boolean;
}

const ACCENT = "#735f55";

export function MergePersonButton<P extends MergePerson>({ source, people, onMerged, disabled }: Props<P>) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => mergeCandidates(people, source.id), [people, source.id]);

  function start() {
    Alert.alert(`Merge ${source.name} into…`, mergeExplainer(source), [
      { text: "Cancel", style: "cancel" },
      { text: "Pick person", onPress: () => setPickerOpen(true) },
    ]);
  }

  function confirm(target: P) {
    Alert.alert(mergeConfirmTitle(source, target), mergeConfirmBody(source, target), [
      { text: "Cancel", style: "cancel" },
      { text: "Merge", style: "destructive", onPress: () => void merge(target) },
    ]);
  }

  async function merge(target: P) {
    setBusy(true);
    try {
      const res = await getClient().mutations.mergePeople({ sourceId: source.id, targetId: target.id });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      Alert.alert("Merged", mergeSummary(source, target, res.data?.rewrites), [
        { text: "OK", onPress: () => onMerged(target) },
      ]);
    } catch (err: any) {
      Alert.alert("Merge failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      <Pressable onPress={start} style={styles.btn} disabled={disabled || busy}>
        {busy ? (
          <ActivityIndicator />
        ) : (
          <>
            <Ionicons name="git-merge-outline" size={16} color={ACCENT} />
            <Text style={styles.text}>Merge into…</Text>
          </>
        )}
      </Pressable>
      <PeoplePickerSheet
        visible={pickerOpen}
        people={candidates}
        selectedIds={[]}
        single
        title={`Merge ${source.name} into`}
        onClose={() => setPickerOpen(false)}
        onChange={(ids) => {
          const target = candidates.find((p) => p.id === ids[0]);
          if (!target) return;
          // Let the sheet finish closing before the confirm alert shows.
          setTimeout(() => confirm(target), 400);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    marginTop: 16,
    paddingVertical: 12,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d8c9bf",
  },
  text: { color: ACCENT, fontWeight: "500", fontSize: 15 },
});
