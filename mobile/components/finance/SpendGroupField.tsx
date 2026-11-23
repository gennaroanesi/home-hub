// Spend group for a transaction: None or a group as chips, and "New group"
// to create one in place (save_finance_spend_group) and pick it. Same op and
// checks (lib/finance/spend-groups.ts) as the web's "New group…".

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { EMPTY_SPEND_GROUP, SPEND_GROUP_KINDS, SPEND_GROUP_KIND_LABELS, spendGroupFields, type SpendGroupDraft } from "../../../lib/finance/spend-groups";
import { Input, cleanAmount, ff } from "./form";
import { ACCENT, Chip, fs } from "./ui";

export type SpendGroup = { id: string; name: string };

let groupsCache: SpendGroup[] | null = null;

/** Spend groups (list_finance_spend_groups), newest first, cached for the session. */
export function useSpendGroups(): [SpendGroup[], (g: SpendGroup) => void] {
  const [groups, setGroups] = useState<SpendGroup[]>(groupsCache ?? []);
  useEffect(() => {
    let live = true;
    void callOp("list_finance_spend_groups", {}).then((r) => {
      if ("error" in r) return;
      groupsCache = r.result.groups;
      if (live) setGroups(r.result.groups);
    });
    return () => {
      live = false;
    };
  }, []);
  const add = (g: SpendGroup) => {
    groupsCache = [g, ...(groupsCache ?? []).filter((x) => x.id !== g.id)];
    setGroups(groupsCache);
  };
  return [groups, add];
}

export function SpendGroupField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [groups, addGroup] = useSpendGroups();
  const [draft, setDraft] = useState<SpendGroupDraft | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!draft) return;
    const checked = spendGroupFields(draft);
    if ("error" in checked) return Alert.alert(checked.error);
    setBusy(true);
    const r = await callOp("save_finance_spend_group", checked.fields);
    setBusy(false);
    if ("error" in r) return Alert.alert("Couldn't create the group", r.error);
    addGroup(r.result.group);
    onChange(r.result.group.id);
    setDraft(null);
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={fs.chipRow}>
        <Chip label="None" on={!value} onPress={() => onChange("")} />
        {groups.map((g) => (
          <Chip key={g.id} label={g.name} on={value === g.id} onPress={() => onChange(g.id)} />
        ))}
        {!draft && (
          <Pressable onPress={() => setDraft(EMPTY_SPEND_GROUP)} style={[fs.chip, { borderColor: ACCENT, flexDirection: "row", alignItems: "center", gap: 2 }]}>
            <Ionicons name="add" size={14} color={ACCENT} />
            <Text style={[fs.chipText, { color: ACCENT }]}>New group</Text>
          </Pressable>
        )}
      </View>
      {draft && (
        <View style={[ff.box, { gap: 8 }]}>
          <Input value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} placeholder="Name (Lake Travis weekend, Nursery…)" autoFocus />
          <View style={fs.chipRow}>
            {SPEND_GROUP_KINDS.map((k) => (
              <Chip key={k} label={SPEND_GROUP_KIND_LABELS[k]} on={draft.kind === k} onPress={() => setDraft({ ...draft, kind: k })} />
            ))}
          </View>
          <Input value={draft.budget} onChangeText={(v) => setDraft({ ...draft, budget: cleanAmount(v) })} placeholder="Budget (optional)" keyboardType="decimal-pad" />
          <View style={fs.rowBetween}>
            <Pressable onPress={() => setDraft(null)} hitSlop={8} disabled={busy}>
              <Text style={fs.muted}>Cancel</Text>
            </Pressable>
            <Pressable style={ff.smallBtn} onPress={create} disabled={busy}>
              {busy ? <ActivityIndicator size="small" /> : <Ionicons name="add" size={14} color={ACCENT} />}
              <Text style={ff.smallBtnText}>Create and pick</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
