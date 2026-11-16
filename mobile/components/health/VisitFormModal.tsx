// Create / edit a homeMedicalVisit. Saving goes through saveVisit
// (lib/health.ts) — the same code the web /health page uses — which keeps
// the visit's calendar event and its care-timeline item in step.
// visitAt is real UTC (Convention A), like calendar events.

import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../../lib/amplify";
import {
  VISIT_KINDS,
  VISIT_KIND_LABELS,
  deleteVisit,
  linkableCareItems,
  saveVisit,
} from "../../../lib/health";
import { formStyles } from "../person-form-styles";
import { AttachmentSection } from "../AttachmentSection";
import { ChipSelect, DateTimeField, SheetHeader, defaultVisitTime } from "./fields";
import type { Schema } from "../../../amplify/data/resource";

type Visit = Schema["homeMedicalVisit"]["type"];
type Provider = Schema["homeHealthProvider"]["type"];
type CareItem = Schema["homeCareItem"]["type"];

const STATUS_OPTIONS = [
  { key: "PLANNED", label: "Planned" },
  { key: "COMPLETED", label: "Completed" },
  { key: "CANCELLED", label: "Cancelled" },
];
const KIND_OPTIONS = VISIT_KINDS.map((k) => ({ key: k as string, label: VISIT_KIND_LABELS[k] }));

interface Props {
  visible: boolean;
  visit: Visit | null;
  personId: string;
  pregnancyId: string | null;
  providers: Provider[];
  /** The selected person's active-pregnancy timeline (empty when none). */
  careItems: CareItem[];
  onClose: () => void;
  onSaved: () => void;
}

export function VisitFormModal({ visible, visit, personId, pregnancyId, providers, careItems, onClose, onSaved }: Props) {
  const [visitAt, setVisitAt] = useState("");
  const [kind, setKind] = useState("PRENATAL");
  const [status, setStatus] = useState("PLANNED");
  const [title, setTitle] = useState("");
  const [providerId, setProviderId] = useState("");
  const [careItemId, setCareItemId] = useState("");
  const [questions, setQuestions] = useState("");
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [weight, setWeight] = useState("");
  const [bpSys, setBpSys] = useState("");
  const [bpDia, setBpDia] = useState("");
  const [fhr, setFhr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setVisitAt(visit?.visitAt ?? defaultVisitTime().toISOString());
    setKind(visit?.kind ?? (pregnancyId ? "PRENATAL" : "CHECKUP"));
    setStatus(visit?.status ?? "PLANNED");
    setTitle(visit?.title ?? "");
    setProviderId(visit?.providerId ?? "");
    setCareItemId(visit?.careItemId ?? "");
    setQuestions(visit?.questions ?? "");
    setNotes(visit?.notes ?? "");
    setFollowUp(visit?.followUp ?? "");
    setWeight(visit?.weightLb != null ? String(visit.weightLb) : "");
    setBpSys(visit?.bpSystolic != null ? String(visit.bpSystolic) : "");
    setBpDia(visit?.bpDiastolic != null ? String(visit.bpDiastolic) : "");
    setFhr(visit?.fetalHeartRate != null ? String(visit.fetalHeartRate) : "");
  }, [visible, visit, pregnancyId]);

  const linkable = linkableCareItems(careItems, visit?.careItemId);

  async function save() {
    if (!visitAt) {
      Alert.alert("Pick a date and time");
      return;
    }
    setBusy(true);
    try {
      const provider = providers.find((p) => p.id === providerId);
      const { syncError } = await saveVisit(getClient(), {
        visitId: visit?.id,
        personId,
        pregnancyId,
        values: {
          visitAt,
          kind,
          status,
          title,
          providerId,
          questions,
          notes,
          followUp,
          weight,
          bpSystolic: bpSys,
          bpDiastolic: bpDia,
          fetalHeartRate: fhr,
        },
        careItemId,
        provider,
        createdBy: "mobile",
      });
      if (syncError) Alert.alert("Visit saved, but the calendar didn't update", syncError);
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!visit) return;
    Alert.alert("Delete this visit?", "Its calendar event and notes are deleted too.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await deleteVisit(getClient(), visit);
            onSaved();
            onClose();
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={formStyles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SheetHeader title={visit ? "Edit visit" : "New visit"} onCancel={onClose} onSave={save} busy={busy} canSave={!!visitAt} />
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={formStyles.label}>When</Text>
          <DateTimeField value={visitAt} onChange={setVisitAt} disabled={busy} />

          <Text style={formStyles.label}>Status</Text>
          <ChipSelect options={STATUS_OPTIONS} value={status} onChange={(k) => k && setStatus(k)} disabled={busy} />
          <Text style={formStyles.hint}>
            {status === "CANCELLED"
              ? "Cancelled visits are taken off the calendar."
              : visit?.eventId
                ? "On the calendar — changes here update the event."
                : "Saving adds this visit to the calendar."}
          </Text>

          <Text style={formStyles.label}>Kind</Text>
          <ChipSelect options={KIND_OPTIONS} value={kind} onChange={(k) => k && setKind(k)} disabled={busy} />

          <Text style={formStyles.label}>Provider</Text>
          {providers.length === 0 ? (
            <Text style={formStyles.hint}>No providers yet — add one on the Health screen.</Text>
          ) : (
            <ChipSelect
              options={providers.map((p) => ({ key: p.id, label: p.name }))}
              value={providerId}
              onChange={setProviderId}
              allowNone
              disabled={busy}
            />
          )}

          <Text style={formStyles.label}>Title</Text>
          <TextInput
            style={formStyles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Intake visit, dating ultrasound…"
            placeholderTextColor="#888"
            editable={!busy}
          />

          {linkable.length > 0 && (
            <>
              <Text style={formStyles.label}>Timeline item this covers</Text>
              <ChipSelect
                options={linkable.map((c) => ({ key: c.id, label: c.title }))}
                value={careItemId}
                onChange={setCareItemId}
                allowNone
                disabled={busy}
              />
              <Text style={formStyles.hint}>Marks it scheduled (planned visit) or done (completed visit).</Text>
            </>
          )}

          <Text style={formStyles.label}>Questions to ask</Text>
          <TextInput
            style={[formStyles.input, formStyles.multiline]}
            value={questions}
            onChangeText={setQuestions}
            placeholder="- Is it OK to keep flying?"
            placeholderTextColor="#888"
            multiline
            editable={!busy}
          />

          {status === "COMPLETED" && (
            <>
              <Text style={formStyles.label}>Vitals</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <VitalInput label="Weight (lb)" value={weight} onChange={setWeight} decimal disabled={busy} />
                <VitalInput label="Fetal HR" value={fhr} onChange={setFhr} disabled={busy} />
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <VitalInput label="BP systolic" value={bpSys} onChange={setBpSys} disabled={busy} />
                <VitalInput label="BP diastolic" value={bpDia} onChange={setBpDia} disabled={busy} />
              </View>

              <Text style={formStyles.label}>Visit summary</Text>
              <TextInput
                style={[formStyles.input, formStyles.multiline, { minHeight: 90 }]}
                value={notes}
                onChangeText={setNotes}
                multiline
                editable={!busy}
              />
              <Text style={formStyles.label}>Follow-up</Text>
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={followUp}
                onChangeText={setFollowUp}
                multiline
                editable={!busy}
              />
            </>
          )}

          {visit ? (
            <>
              <Text style={formStyles.label}>Files</Text>
              <AttachmentSection parentType="VISIT" parentId={visit.id} />
            </>
          ) : (
            <Text style={[formStyles.hint, { marginTop: 12 }]}>Save the visit to attach files.</Text>
          )}

          {visit && (
            <Pressable onPress={confirmDelete} style={formStyles.deleteBtn} disabled={busy}>
              <Text style={formStyles.deleteText}>Delete visit</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function VitalInput({
  label,
  value,
  onChange,
  decimal = false,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  decimal?: boolean;
  disabled: boolean;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={formStyles.hint}>{label}</Text>
      <TextInput
        style={formStyles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={decimal ? "decimal-pad" : "number-pad"}
        editable={!disabled}
      />
    </View>
  );
}
