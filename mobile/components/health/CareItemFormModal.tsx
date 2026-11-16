// Create / edit a pregnancy care-timeline item (homeCareItem). Saving goes
// through saveCareItem (lib/health.ts), shared with the web /health page:
// Scheduled books it (moving the linked visit or creating a planned one, on
// the calendar), Done completes it (and a planned linked visit).

import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { getClient } from "../../lib/amplify";
import {
  careItemDeletePrompt,
  careItemFormError,
  deleteCareItem,
  saveCareItem,
} from "../../../lib/health";
import {
  CARE_CATEGORIES,
  CARE_CATEGORY_LABELS,
  CARE_STATUSES,
  CARE_STATUS_LABELS,
  type CareStatus,
} from "../../../lib/pregnancy";
import { formStyles } from "../person-form-styles";
import { AttachmentSection } from "../AttachmentSection";
import { ChipSelect, DateField, DateTimeField, SheetHeader } from "./fields";
import type { Schema } from "../../../amplify/data/resource";

type CareItem = Schema["homeCareItem"]["type"];

const CATEGORY_OPTIONS = CARE_CATEGORIES.map((c) => ({ key: c as string, label: CARE_CATEGORY_LABELS[c] }));
const STATUS_OPTIONS = CARE_STATUSES.map((s) => ({ key: s as string, label: CARE_STATUS_LABELS[s] }));

interface Props {
  visible: boolean;
  item: CareItem | null;
  /** Status picked from the row that needs a date (Scheduled / Done). */
  presetStatus: CareStatus | null;
  pregnancyId: string;
  personId: string;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}

export function CareItemFormModal({ visible, item, presetStatus, pregnancyId, personId, today, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("VISIT");
  const [status, setStatus] = useState("UPCOMING");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [addToCalendar, setAddToCalendar] = useState(true);
  const [completedAt, setCompletedAt] = useState("");
  const [optional, setOptional] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTitle(item?.title ?? "");
    setCategory(item?.category ?? "VISIT");
    setStatus(presetStatus ?? item?.status ?? "UPCOMING");
    setWindowStart(item?.windowStart ?? today);
    setWindowEnd(item?.windowEnd ?? today);
    setScheduledAt(item?.scheduledAt ?? "");
    setAddToCalendar(true);
    setCompletedAt(item?.completedAt ?? (presetStatus === "DONE" ? today : ""));
    setOptional(!!item?.optional);
    setNotes(item?.notes ?? "");
  }, [visible, item, presetStatus, today]);

  const hasVisit = !!item?.visitId;
  const canSave = !!title.trim() && !!windowStart && !!windowEnd;

  async function save() {
    const formError = careItemFormError({ title, windowStart, windowEnd, status, scheduledAt });
    if (formError) {
      Alert.alert(formError);
      return;
    }
    setBusy(true);
    try {
      await saveCareItem(getClient(), {
        itemId: item?.id,
        pregnancyId,
        personId,
        details: { title, category, windowStart, windowEnd, optional, notes },
        status,
        scheduledAt: status === "SCHEDULED" ? scheduledAt : null,
        withVisit: addToCalendar,
        completedAt,
        today,
      });
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!item) return;
    Alert.alert("Delete item?", careItemDeletePrompt(item), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await deleteCareItem(getClient(), item.id);
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
        <SheetHeader
          title={item ? "Edit timeline item" : "New timeline item"}
          onCancel={onClose}
          onSave={save}
          busy={busy}
          canSave={canSave}
        />
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={formStyles.label}>Title</Text>
          <TextInput
            style={formStyles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Anatomy scan"
            placeholderTextColor="#888"
            editable={!busy}
            autoFocus={!item}
          />

          <Text style={formStyles.label}>Status</Text>
          <ChipSelect options={STATUS_OPTIONS} value={status} onChange={(k) => k && setStatus(k)} disabled={busy} />

          {status === "SCHEDULED" && (
            <>
              <Text style={formStyles.label}>Booked for</Text>
              <DateTimeField value={scheduledAt} onChange={setScheduledAt} disabled={busy} />
              {hasVisit ? (
                <Text style={formStyles.hint}>Linked to a visit — it and its calendar event move to this time.</Text>
              ) : (
                <View style={[formStyles.switchRow, { marginTop: 6 }]}>
                  <Text style={formStyles.switchLabel}>Add to the calendar as a visit</Text>
                  <Switch value={addToCalendar} onValueChange={setAddToCalendar} disabled={busy} />
                </View>
              )}
            </>
          )}
          {status === "DONE" && (
            <>
              <Text style={formStyles.label}>Done on</Text>
              <DateField value={completedAt} onChange={setCompletedAt} disabled={busy} />
              {hasVisit && <Text style={formStyles.hint}>The linked visit is marked completed too.</Text>}
            </>
          )}

          <Text style={formStyles.label}>Category</Text>
          <ChipSelect options={CATEGORY_OPTIONS} value={category} onChange={(k) => k && setCategory(k)} disabled={busy} />

          <Text style={formStyles.label}>Window opens</Text>
          <DateField value={windowStart} onChange={setWindowStart} disabled={busy} />
          <Text style={formStyles.label}>Window closes</Text>
          <DateField value={windowEnd} onChange={setWindowEnd} disabled={busy} />
          {!!item?.key && (
            <Text style={formStyles.hint}>
              Standard timeline item — if the due date changes, its window moves too while it's still open.
            </Text>
          )}

          <View style={[formStyles.switchRow, { marginTop: 12 }]}>
            <Text style={formStyles.switchLabel}>Optional</Text>
            <Switch value={optional} onValueChange={setOptional} disabled={busy} />
          </View>

          <Text style={formStyles.label}>Notes</Text>
          <TextInput
            style={[formStyles.input, formStyles.multiline]}
            value={notes}
            onChangeText={setNotes}
            multiline
            editable={!busy}
          />

          {item && (
            <>
              <Text style={formStyles.label}>Files</Text>
              <AttachmentSection parentType="CARE_ITEM" parentId={item.id} />
              <Pressable onPress={confirmDelete} style={formStyles.deleteBtn} disabled={busy}>
                <Text style={formStyles.deleteText}>Delete item</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
