// Suggest tab of the mobile Wardrobe: the outfit suggester (suggestOutfit
// mutation → wardrobe-suggest Lambda), as on the web: a day, an occasion,
// a description and wearing instructions; three outfits back, each with
// Save as look and Wear it today. Try-on previews stay on the web.

import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../../lib/amplify";
import { addDaysYmd } from "../../../lib/wardrobe";
import { tripDayLabel } from "../../../lib/wardrobe-trip-edits";
import { LookCard } from "./LookCard";
import type { LookDraft } from "./LookFormModal";
import { Chip, todayYmd, wardrobeStyles as ws, type WardrobeItem } from "./shared";

interface Suggestion {
  title: string;
  palette?: string | null;
  occasion?: string | null;
  itemIds?: (string | null)[] | null;
  why?: string | null;
  wishlistItemIds?: (string | null)[] | null;
}

const ids = (v: (string | null)[] | null | undefined) => (v ?? []).filter((x): x is string => !!x);

export function SuggestView({
  personId,
  personName,
  byId,
  onOpenItem,
  onSave,
  onWear,
}: {
  personId: string;
  personName: string;
  byId: Map<string, WardrobeItem>;
  onOpenItem: (it: WardrobeItem) => void;
  onSave: (draft: LookDraft) => void;
  onWear: (itemIds: string[]) => void;
}) {
  const today = todayYmd();
  const days = Array.from({ length: 7 }, (_, n) => addDaysYmd(today, n));
  const [date, setDate] = useState(today);
  const [occasion, setOccasion] = useState("");
  const [request, setRequest] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [context, setContext] = useState("");
  const [brief, setBrief] = useState({ instructions: "", text: "" });

  async function run() {
    setBusy(true);
    setError("");
    try {
      const { data, errors } = await getClient().mutations.suggestOutfit({
        personId,
        date,
        occasion: occasion.trim() || null,
        request: [request.trim(), instructions.trim() && `Wearing instructions: ${instructions.trim()}`].filter(Boolean).join("\n") || null,
        count: 3,
      });
      if (errors?.length) throw new Error(errors[0].message);
      if (data?.error && !data.suggestions?.length) throw new Error(data.error);
      setResults((data?.suggestions ?? []).filter((s): s is NonNullable<typeof s> => !!s));
      setContext(data?.context ?? "");
      setBrief({ instructions: instructions.trim(), text: [occasion.trim(), request.trim()].filter(Boolean).join("\n") });
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      <View style={ws.card}>
        <Text style={ws.body}>
          Picks outfits from {personName}&apos;s closet using the style brief in Closet settings, the day&apos;s weather and calendar, and what was
          worn in the last few days.
        </Text>
        <Text style={ws.sectionLabel}>Day</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ws.chipRow}>
          {days.map((d, n) => (
            <Chip key={d} on={date === d} onPress={() => setDate(d)} label={n === 0 ? "Today" : n === 1 ? "Tomorrow" : tripDayLabel(d)} />
          ))}
        </ScrollView>
        <Text style={ws.sectionLabel}>Occasion</Text>
        <TextInput style={ws.input} value={occasion} onChangeText={setOccasion} placeholder="Office, golf, dinner out…" placeholderTextColor="#999" />
        <Text style={ws.sectionLabel}>Describe the look</Text>
        <TextInput
          style={[ws.input, ws.multiline]}
          value={request}
          onChangeText={setRequest}
          multiline
          placeholder="Dinner downtown, relaxed but polished. Use my chestnut boots…"
          placeholderTextColor="#999"
        />
        <Text style={ws.sectionLabel}>How to wear the pieces</Text>
        <TextInput
          style={[ws.input, ws.multiline]}
          value={instructions}
          onChangeText={setInstructions}
          multiline
          maxLength={2000}
          placeholder="Shirt tucked in, jacket open…"
          placeholderTextColor="#999"
        />
        <Pressable onPress={run} disabled={busy} style={[ws.btn, ws.btnPrimary, { alignSelf: "flex-start" }, busy && ws.disabled]}>
          {busy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="sparkles" size={14} color="#fff" />}
          <Text style={ws.btnPrimaryText}>{busy ? "Thinking…" : "Suggest outfits"}</Text>
        </Pressable>
        {!!error && <Text style={{ color: "#c44" }}>{error}</Text>}
      </View>

      {!!context && <Text style={[ws.meta, { marginBottom: 8 }]}>Based on: {context}</Text>}
      {results.map((s, n) => (
        <LookCard
          key={`${n}-${s.title}`}
          title={s.title}
          occasion={s.occasion}
          palette={s.palette}
          note={s.why}
          itemIds={s.itemIds}
          wishlistItemIds={s.wishlistItemIds}
          byId={byId}
          onOpenItem={onOpenItem}
          actions={
            <>
              <Pressable
                onPress={() =>
                  onSave({
                    title: s.title,
                    palette: s.palette,
                    occasion: s.occasion,
                    note: s.why,
                    itemIds: ids(s.itemIds),
                    stylingInstructions: brief.instructions || null,
                    generationBrief: brief.text || null,
                    source: "SUGGESTED",
                  })
                }
                style={[ws.btn, ws.btnFlat, ws.btnSmall]}
              >
                <Text style={[ws.btnFlatText, ws.btnSmallText]}>Save as look</Text>
              </Pressable>
              <Pressable onPress={() => onWear(ids(s.itemIds))} style={[ws.btn, ws.btnSmall]}>
                <Text style={[ws.link, ws.btnSmallText]}>Wear it today</Text>
              </Pressable>
            </>
          }
        />
      ))}
    </View>
  );
}
