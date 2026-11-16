// Looks tab of the mobile Wardrobe: saved looks with search, occasion and
// "Has try-on" chips (lib/wardrobe.ts filterLooks, same as the web), each
// with Wore it today and Edit.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { filterLooks, lookOccasions } from "../../../lib/wardrobe";
import { LookCard } from "./LookCard";
import { Chip, wardrobeStyles as ws, type WardrobeItem, type WardrobeLook } from "./shared";

export function LooksView({
  looks,
  byId,
  onOpenItem,
  onEdit,
  onWear,
}: {
  looks: WardrobeLook[];
  byId: Map<string, WardrobeItem>;
  onOpenItem: (it: WardrobeItem) => void;
  onEdit: (l: WardrobeLook) => void;
  onWear: (l: WardrobeLook) => void;
}) {
  const [search, setSearch] = useState("");
  const [occasion, setOccasion] = useState("");
  const [tryOn, setTryOn] = useState(false);
  const occasions = useMemo(() => lookOccasions(looks), [looks]);
  const shown = filterLooks(looks, { occasion, tryOn, search }, byId);

  if (!looks.length) {
    return (
      <View style={ws.emptyBox}>
        <Text style={{ color: "#888", textAlign: "center" }}>No looks yet. Tap + to build one, or save one from Suggest or a trip.</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={ws.searchWrap}>
        <Ionicons name="search" size={16} color="#999" />
        <TextInput
          style={ws.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search title, occasion, palette, pieces…"
          placeholderTextColor="#999"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ws.chipRow}>
        <Chip on={!occasion} onPress={() => setOccasion("")} label="Any occasion" count={looks.length} />
        {occasions.map(([k, o]) => (
          <Chip key={k} on={occasion === k} onPress={() => setOccasion(occasion === k ? "" : k)} label={o.label} count={o.count} />
        ))}
        <Chip on={tryOn} onPress={() => setTryOn((v) => !v)} label="Has try-on" count={looks.filter((l) => l.previewImageKey).length} />
      </ScrollView>
      {!shown.length && <Text style={ws.empty}>Nothing matches these filters.</Text>}
      <View style={{ marginTop: 6 }}>
        {shown.map((l) => (
          <LookCard
            key={l.id}
            title={l.title}
            occasion={l.occasion}
            palette={l.palette}
            note={l.note}
            itemIds={l.itemIds}
            previewImageKey={l.previewImageKey}
            byId={byId}
            onOpenItem={onOpenItem}
            actions={
              <>
                <Pressable onPress={() => onWear(l)} style={[ws.btn, ws.btnFlat, ws.btnSmall]}>
                  <Text style={[ws.btnFlatText, ws.btnSmallText]}>Wore it today</Text>
                </Pressable>
                <Pressable onPress={() => onEdit(l)} style={[ws.btn, ws.btnSmall]}>
                  <Text style={[ws.link, ws.btnSmallText]}>Edit</Text>
                </Pressable>
              </>
            }
          />
        ))}
      </View>
    </View>
  );
}
