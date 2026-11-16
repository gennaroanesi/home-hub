// Start tracking a pregnancy (create) or edit the active one. Both go
// through lib/pregnancy.ts (createPregnancy seeds the care timeline;
// updatePregnancy moves open standard items when the due date changes),
// the same code the web /health page runs.

import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
} from "react-native";

import { getClient } from "../../lib/amplify";
import { formatYmdShort } from "../../../lib/health";
import {
  DUE_DATE_SOURCE_OPTIONS,
  PREGNANCY_STATUS_OPTIONS,
  createPregnancy,
  dueDateFromLmp,
  gestationalAge,
  lmpFromDueDate,
  updatePregnancy,
} from "../../../lib/pregnancy";
import { formStyles } from "../person-form-styles";
import { ChipSelect, DateField, SheetHeader } from "./fields";
import type { Schema } from "../../../amplify/data/resource";

type Pregnancy = Schema["homePregnancy"]["type"];
type Provider = Schema["homeHealthProvider"]["type"];

interface Props {
  visible: boolean;
  /** null = start tracking a new pregnancy for personId. */
  pregnancy: Pregnancy | null;
  personId: string;
  providers: Provider[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}

export function PregnancyFormModal({ visible, pregnancy, personId, providers, today, onClose, onSaved }: Props) {
  const [dueDate, setDueDate] = useState("");
  const [lmpDate, setLmpDate] = useState("");
  const [source, setSource] = useState("OTHER");
  const [providerId, setProviderId] = useState("");
  const [hospital, setHospital] = useState("");
  const [status, setStatus] = useState("ACTIVE");
  const [deliveredAt, setDeliveredAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDueDate(pregnancy?.dueDate ?? "");
    setLmpDate(pregnancy?.lmpDate ?? "");
    setSource(pregnancy?.dueDateSource ?? "OTHER");
    setProviderId(pregnancy?.providerId ?? "");
    setHospital(pregnancy?.hospitalName ?? "");
    setStatus(pregnancy?.status ?? "ACTIVE");
    setDeliveredAt(pregnancy?.deliveredAt ?? "");
    setNotes(pregnancy?.notes ?? "");
  }, [visible, pregnancy]);

  // Editing: due date and LMP are 280 days apart, so changing one moves
  // the other. Creating keeps them independent (createPregnancy decides).
  function onDueChange(v: string) {
    setDueDate(v);
    if (v && pregnancy) setLmpDate(lmpFromDueDate(v));
  }
  function onLmpChange(v: string) {
    setLmpDate(v);
    if (v && pregnancy) {
      setDueDate(dueDateFromLmp(v));
      setSource("LMP");
    }
  }

  // Creating: the due date wins when both are given (as on the web).
  const effectiveDue = pregnancy ? dueDate : dueDate || (lmpDate ? dueDateFromLmp(lmpDate) : "");
  const dueChanged = !!pregnancy && !!dueDate && dueDate !== pregnancy.dueDate;

  async function save() {
    if (!effectiveDue) return;
    setBusy(true);
    try {
      const client = getClient();
      if (pregnancy) {
        const moved = await updatePregnancy(client, pregnancy, {
          dueDate,
          lmpDate,
          dueDateSource: source,
          providerId,
          hospitalName: hospital,
          status,
          deliveredAt,
          notes,
        });
        if (moved > 0) {
          Alert.alert("Pregnancy updated", `${moved} timeline item${moved === 1 ? "" : "s"} moved to match the new due date.`);
        }
      } else {
        const { failed } = await createPregnancy(client, { personId, lmp: lmpDate, due: dueDate });
        if (failed > 0) {
          Alert.alert("Pregnancy added", `${failed} timeline item(s) failed to save — add them by hand.`);
        }
      }
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={formStyles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SheetHeader
          title={pregnancy ? "Edit pregnancy" : "Track a pregnancy"}
          onCancel={onClose}
          onSave={save}
          busy={busy}
          canSave={!!effectiveDue}
        />
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={formStyles.label}>{pregnancy ? "Due date" : "Due date (if known)"}</Text>
          <DateField value={dueDate} onChange={onDueChange} clearable={!pregnancy} disabled={busy} />
          <Text style={formStyles.label}>First day of last period</Text>
          <DateField value={lmpDate} onChange={onLmpChange} clearable disabled={busy} />
          {!pregnancy && !!effectiveDue && (
            <Text style={formStyles.hint}>
              Due {formatYmdShort(effectiveDue)} · currently {gestationalAge(effectiveDue, today).label}. The standard
              care timeline is added for you.
            </Text>
          )}

          {pregnancy && (
            <>
              <Text style={formStyles.label}>Due date set by</Text>
              <ChipSelect options={DUE_DATE_SOURCE_OPTIONS} value={source} onChange={(k) => k && setSource(k)} disabled={busy} />
              {dueChanged && (
                <Text style={[formStyles.hint, { color: "#a66a00" }]}>
                  Open timeline items will move to match the new due date. Done items and ones you added by hand stay
                  put.
                </Text>
              )}

              <Text style={formStyles.label}>OB / midwife</Text>
              {providers.length === 0 ? (
                <Text style={formStyles.hint}>No providers yet.</Text>
              ) : (
                <ChipSelect
                  options={providers.map((p) => ({ key: p.id, label: p.name }))}
                  value={providerId}
                  onChange={setProviderId}
                  allowNone
                  disabled={busy}
                />
              )}
              <Text style={formStyles.label}>Hospital</Text>
              <TextInput style={formStyles.input} value={hospital} onChangeText={setHospital} editable={!busy} />

              <Text style={formStyles.label}>Status</Text>
              <ChipSelect options={PREGNANCY_STATUS_OPTIONS} value={status} onChange={(k) => k && setStatus(k)} disabled={busy} />
              {status === "DELIVERED" && (
                <>
                  <Text style={formStyles.label}>Birth date</Text>
                  <DateField value={deliveredAt} onChange={setDeliveredAt} disabled={busy} />
                </>
              )}

              <Text style={formStyles.label}>Notes</Text>
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={notes}
                onChangeText={setNotes}
                multiline
                editable={!busy}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
