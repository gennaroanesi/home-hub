// Add or edit an inventory item on the phone. Saves through
// manage_inventory_item, like the web and Janet; the detail section comes
// from the category's type (DetailInputs). Firearms and ammo are
// owner-only: they always belong to whoever saves them.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { callOp } from "../../lib/ops";
import { resizedImageUrl } from "../../lib/image";
import { DETAIL_SPECS, detailSpec, type DetailType } from "../../../lib/inventory-details";
import { ACQUIRED_VIA_LABELS, PRIORITY_LABELS } from "../../../lib/inventory";
import { DateField, Field, FormSheet, Input, cleanAmount } from "../finance/form";
import { ACCENT, DANGER, fs, type OpResultOf } from "../finance/ui";
import { OptionSheet, choosePhotoSource } from "../wardrobe/shared";
import { ChipRow, DetailInputs } from "./DetailInputs";
import { CategorySheet } from "./CategorySheet";
import { forgetInventoryRefs } from "./refs";

export type InventoryItem = OpResultOf<"list_inventory">["items"][number];
export type InventoryCategory = OpResultOf<"list_inventory_categories">["categories"][number];

const STATUS_LABELS: Record<string, string> = { OWNED: "Owned", WISHLIST: "Wishlist", SOLD: "Sold", GIVEN_AWAY: "Given away", DRAFT: "Draft" };

type Picker = null | "category" | "room" | "parent";

export function ItemFormModal({
  visible,
  item,
  defaultStatus,
  defaultCategoryId,
  categories,
  items,
  lists,
  rooms,
  owners,
  onClose,
  onSaved,
}: {
  visible: boolean;
  item: InventoryItem | null;
  defaultStatus: "OWNED" | "WISHLIST";
  /** New items start in this category (the list it was added from). */
  defaultCategoryId?: string;
  categories: InventoryCategory[];
  items: InventoryItem[];
  lists: Array<{ id: string; name: string }>;
  rooms: Array<{ id: string; label: string }>;
  /** Owner keys as the ops take them: "household", a person id, "pet:<id>". */
  owners: Array<{ key: string; label: string }>;
  onClose: () => void;
  onSaved: (item: InventoryItem | null) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [picker, setPicker] = useState<Picker>(null);
  const set = (k: string) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!visible) return;
    const s = (v: unknown) => (v == null ? "" : String(v));
    const e = item;
    setPhotos(e?.imageKeys ?? []);
    setDetails(Object.fromEntries(Object.entries(e?.details ?? {}).map(([k, v]) => [k, s(v)])));
    setF({
      name: s(e?.name),
      categoryId: s(e ? e.categoryId : defaultCategoryId),
      status: s(e?.status ?? defaultStatus),
      owner: e ? (e.petId ? `pet:${e.petId}` : e.pregnancyId ? `baby:${e.pregnancyId}` : (e.ownerPersonId ?? "household")) : "household",
      roomId: s(e?.roomId),
      parentItemId: s(e?.parentItemId),
      brand: s(e?.brand),
      quantity: s(e?.quantity ?? 1),
      location: s(e?.location),
      notes: s(e?.notes),
      url: s(e?.url),
      tags: (e?.tags ?? []).join(", "),
      priority: s(e?.priority),
      neededBy: s(e?.neededBy),
      estimatedPrice: s(e?.estimatedPrice),
      acquiredVia: s(e?.acquiredVia),
      giftFrom: s(e?.giftFrom),
      vendor: s(e?.vendor),
      acquiredAt: s(e?.acquiredAt),
      pricePaid: s(e?.pricePaid),
      priceSold: s(e?.priceSold),
    });
  }, [visible, item, defaultStatus, defaultCategoryId]);

  // Categories made from the picker, until the refs reload.
  const [created, setCreated] = useState<InventoryCategory[]>([]);
  const allCategories = useMemo(() => [...categories, ...created.filter((c) => !categories.some((x) => x.id === c.id))], [categories, created]);
  const category = allCategories.find((c) => c.id === f.categoryId);
  const type = (category?.detailType ?? null) as DetailType | null;
  const isPrivate = !!detailSpec(type)?.private;
  const room = rooms.find((r) => r.id === f.roomId);
  const parent = items.find((i) => i.id === f.parentItemId);
  const parentOptions = useMemo(
    () => items.filter((i) => i.id !== item?.id && i.parentItemId !== item?.id && i.status !== "SOLD" && i.status !== "GIVEN_AWAY").sort((a, b) => a.name.localeCompare(b.name)),
    [items, item],
  );
  const num = (k: string) => (f[k]?.trim() && !Number.isNaN(Number(f[k])) ? Number(f[k]) : null);
  const status = f.status;
  const ownerOptions = item?.pregnancyId ? [{ key: `baby:${item.pregnancyId}`, label: "Baby on the way" }, ...owners] : owners;

  async function save() {
    if (!f.name?.trim()) return Alert.alert("Give it a name");
    if (!f.categoryId && !item) return Alert.alert("Pick a category");
    setBusy(true);
    try {
      const r = await callOp("manage_inventory_item", {
        action: item ? "update" : "create",
        ...(item ? { itemId: item.id } : {}),
        name: f.name.trim(),
        categoryId: f.categoryId || null,
        ...(status === "DRAFT" ? {} : { status: status as "OWNED" | "WISHLIST" | "SOLD" | "GIVEN_AWAY" }),
        ...(isPrivate ? {} : { ownerName: f.owner || "household" }),
        roomId: f.roomId || null,
        partOf: f.parentItemId || "",
        imageKeys: photos,
        brand: f.brand,
        quantity: Math.max(0, Math.round(num("quantity") ?? 1)),
        location: f.location,
        tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        notes: f.notes,
        url: f.url,
        priority: (f.priority || null) as "MUST_HAVE" | "NICE_TO_HAVE" | null,
        neededBy: f.neededBy,
        estimatedPrice: num("estimatedPrice"),
        acquiredVia: (f.acquiredVia || null) as "PURCHASED" | "GIFT" | "HAND_ME_DOWN" | null,
        giftFrom: f.giftFrom,
        vendor: f.vendor,
        acquiredAt: f.acquiredAt,
        pricePaid: num("pricePaid"),
        priceSold: num("priceSold"),
        ...(type ? { details: Object.fromEntries(DETAIL_SPECS[type].fields.map((fl) => [fl.key, details[fl.key] ?? ""])) } : {}),
      });
      if ("error" in r) throw new Error(r.error);
      if (r.result.restock?.addedToList) Alert.alert("Running low", `Added to ${r.result.restock.addedToList}.`);
      onSaved(r.result.item);
    } catch (err) {
      Alert.alert("Couldn't save", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!item) return;
    Alert.alert(`Delete "${item.name}"?`, item.partCount ? "Its parts stay, just not attached to it." : undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const r = await callOp("manage_inventory_item", { action: "delete", itemId: item.id });
          setBusy(false);
          if ("error" in r) Alert.alert("Couldn't delete", r.error);
          else onSaved(null);
        },
      },
    ]);
  }

  const qtyLabel = type === "AMMO" ? `Quantity (${(DETAIL_SPECS.AMMO.fields[1].optionLabels?.[details.unit ?? ""] ?? "units").toLowerCase()})` : type === "FILAMENT" ? "Spools" : "Quantity";

  return (
    <FormSheet visible={visible} title={item ? "Edit item" : "Add item"} onClose={onClose} onSave={save} busy={busy} canSave={!!f.name?.trim()}>
      <Field label="Name">
        <Input value={f.name ?? ""} onChangeText={set("name")} placeholder="What is it?" autoFocus={!item} />
      </Field>
      <Field label="Category">
        <PickerButton label={category?.path ?? "Pick a category"} muted={!category} onPress={() => setPicker("category")} />
      </Field>
      <Field label="Status">
        <ChipRow
          options={["OWNED", "WISHLIST", "SOLD", "GIVEN_AWAY", ...(item?.status === "DRAFT" ? ["DRAFT"] : [])].map((v) => ({ value: v, label: STATUS_LABELS[v] }))}
          value={f.status ?? ""}
          onChange={(v) => v && set("status")(v)}
        />
      </Field>
      <Field label="Belongs to" hint={isPrivate ? "Firearms and ammo are yours alone: nobody else in the household sees them" : undefined}>
        {isPrivate ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name="lock-closed" size={14} color="#888" />
            <Text style={fs.text}>You</Text>
          </View>
        ) : (
          <ChipRow options={ownerOptions.map((o) => ({ value: o.key, label: o.label }))} value={f.owner ?? ""} onChange={(v) => set("owner")(v || "household")} />
        )}
      </Field>

      {type && (
        <View style={{ gap: 12 }}>
          <Text style={[fs.label, { marginTop: 4 }]}>{DETAIL_SPECS[type].label} details</Text>
          <DetailInputs type={type} values={details} onChange={(k, v) => setDetails((p) => ({ ...p, [k]: v }))} lists={lists} />
        </View>
      )}

      <Field label="Brand">
        <Input value={f.brand ?? ""} onChangeText={set("brand")} />
      </Field>
      <Field label={qtyLabel}>
        <Input value={f.quantity ?? ""} onChangeText={(t) => set("quantity")(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" />
      </Field>
      {parentOptions.length > 0 && (
        <Field label="Part of / installed on" hint="An optic on a rifle, pickups in a guitar">
          <PickerButton label={parent?.name ?? "Nothing (standalone)"} muted={!parent} onPress={() => setPicker("parent")} onClear={parent ? () => set("parentItemId")("") : undefined} />
        </Field>
      )}
      {rooms.length > 0 && (
        <Field label="Room">
          <PickerButton label={room?.label ?? "Not set"} muted={!room} onPress={() => setPicker("room")} onClear={room ? () => set("roomId")("") : undefined} />
        </Field>
      )}
      <Field label={rooms.length > 0 ? "Where in the room" : "Location"}>
        <Input value={f.location ?? ""} onChangeText={set("location")} placeholder="Top shelf, gray box" />
      </Field>

      {status === "WISHLIST" ? (
        <>
          <Field label="Estimated price (each)">
            <Input value={f.estimatedPrice ?? ""} onChangeText={(t) => set("estimatedPrice")(cleanAmount(t))} keyboardType="decimal-pad" placeholder="$" />
          </Field>
          <Field label="Priority">
            <ChipRow options={Object.entries(PRIORITY_LABELS).map(([v, l]) => ({ value: v, label: l }))} value={f.priority ?? ""} onChange={set("priority")} />
          </Field>
          <Field label="Needed by">
            <DateField value={f.neededBy ?? ""} onChange={set("neededBy")} clearable />
          </Field>
        </>
      ) : (
        <>
          <Field label="Got it as">
            <ChipRow options={Object.entries(ACQUIRED_VIA_LABELS).map(([v, l]) => ({ value: v, label: l }))} value={f.acquiredVia ?? ""} onChange={set("acquiredVia")} />
          </Field>
          {f.acquiredVia === "GIFT" || f.acquiredVia === "HAND_ME_DOWN" ? (
            <Field label="From">
              <Input value={f.giftFrom ?? ""} onChangeText={set("giftFrom")} />
            </Field>
          ) : (
            <Field label="Price paid (each)">
              <Input value={f.pricePaid ?? ""} onChangeText={(t) => set("pricePaid")(cleanAmount(t))} keyboardType="decimal-pad" placeholder="$" />
            </Field>
          )}
          <Field label="Store">
            <Input value={f.vendor ?? ""} onChangeText={set("vendor")} />
          </Field>
          <Field label="Date">
            <DateField value={f.acquiredAt ?? ""} onChange={set("acquiredAt")} clearable />
          </Field>
        </>
      )}
      {status === "SOLD" && (
        <Field label="Sold for">
          <Input value={f.priceSold ?? ""} onChangeText={(t) => set("priceSold")(cleanAmount(t))} keyboardType="decimal-pad" placeholder="$" />
        </Field>
      )}

      <Field label="Photos">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {photos.map((k) => (
            <View key={k}>
              <Image source={{ uri: resizedImageUrl(k, 240) }} style={{ width: 84, height: 84, borderRadius: 8, backgroundColor: "#eee" }} contentFit="cover" />
              <Pressable onPress={() => setPhotos((p) => p.filter((x) => x !== k))} hitSlop={8} style={{ position: "absolute", top: 4, right: 4, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 10 }}>
                <Ionicons name="close" size={16} color="#fff" />
              </Pressable>
            </View>
          ))}
          <Pressable
            onPress={() => choosePhotoSource((keys) => setPhotos((p) => [...p, ...keys]), setUploading, 6, false, "inventory")}
            style={({ pressed }) => [{ width: 84, height: 84, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", borderStyle: "dashed", alignItems: "center", justifyContent: "center" }, pressed && fs.pressed]}
          >
            {uploading ? <ActivityIndicator /> : <Ionicons name="camera-outline" size={24} color={ACCENT} />}
          </Pressable>
        </ScrollView>
      </Field>
      <Field label="Link">
        <Input value={f.url ?? ""} onChangeText={set("url")} autoCapitalize="none" keyboardType="url" placeholder="https://" />
      </Field>
      <Field label="Tags" hint="Comma separated: nursery, feeding">
        <Input value={f.tags ?? ""} onChangeText={set("tags")} autoCapitalize="none" />
      </Field>
      <Field label="Notes">
        <Input value={f.notes ?? ""} onChangeText={set("notes")} multiline />
      </Field>

      {item && (
        <Pressable onPress={remove} style={({ pressed }) => [{ paddingVertical: 14, alignItems: "center" }, pressed && fs.pressed]}>
          <Text style={{ color: DANGER, fontSize: 16 }}>Delete item</Text>
        </Pressable>
      )}

      <CategorySheet
        visible={picker === "category"}
        categories={allCategories}
        selected={f.categoryId}
        onPick={set("categoryId")}
        onCreated={(c) => {
          setCreated((prev) => [...prev, c]);
          forgetInventoryRefs();
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet visible={picker === "room"} title="Room" options={rooms.map((r) => ({ value: r.id, label: r.label }))} selected={f.roomId} onPick={set("roomId")} onClose={() => setPicker(null)} />
      <OptionSheet
        visible={picker === "parent"}
        title="Installed on"
        options={parentOptions.map((i) => ({ value: i.id, label: i.category ? `${i.name} · ${i.category}` : i.name }))}
        selected={f.parentItemId}
        onPick={set("parentItemId")}
        onClose={() => setPicker(null)}
      />
    </FormSheet>
  );
}

function PickerButton({ label, muted, onPress, onClear }: { label: string; muted?: boolean; onPress: () => void; onClear?: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [fs.rowBetween, { borderWidth: 1, borderColor: "#e3e3e3", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, backgroundColor: "#fff" }, pressed && fs.pressed]}>
      <Text style={[fs.textFlex, muted && { color: "#999" }]} numberOfLines={1}>
        {label}
      </Text>
      {onClear ? (
        <Pressable onPress={onClear} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color="#bbb" />
        </Pressable>
      ) : (
        <Ionicons name="chevron-down" size={16} color="#999" />
      )}
    </Pressable>
  );
}

