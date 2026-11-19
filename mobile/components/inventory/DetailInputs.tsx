// The detail fields of an inventory item's type on the phone, generated
// from lib/inventory-details.ts like the web form: text with suggestion
// chips, number pads with units, choice chips, a switch, a date, a
// shopping list. Values are strings; the inventory ops check and convert.

import { ScrollView, Switch, Text, View } from "react-native";

import { DETAIL_SPECS, type DetailField, type DetailType } from "../../../lib/inventory-details";
import { DateField, Field, Input } from "../finance/form";
import { ACCENT, Chip, fs } from "../finance/ui";

export function DetailInputs({
  type,
  values,
  onChange,
  lists,
}: {
  type: DetailType;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  lists: Array<{ id: string; name: string }>;
}) {
  return (
    <>
      {DETAIL_SPECS[type].fields.map((f) => (
        <DetailInput key={f.key} field={f} value={values[f.key] ?? ""} onChange={(v) => onChange(f.key, v)} lists={lists} />
      ))}
    </>
  );
}

function DetailInput({ field: f, value, onChange, lists }: { field: DetailField; value: string; onChange: (v: string) => void; lists: Array<{ id: string; name: string }> }) {
  const label = f.unit ? `${f.label} (${f.unit})` : f.label;
  switch (f.kind) {
    case "choice":
      return (
        <Field label={label} hint={f.hint}>
          <ChipRow options={(f.options ?? []).map((o) => ({ value: o, label: f.optionLabels?.[o] ?? o }))} value={value} onChange={onChange} />
        </Field>
      );
    case "shoppingList":
      return (
        <Field label={label} hint="Default: the supermarket list">
          <ChipRow options={lists.map((l) => ({ value: l.id, label: l.name }))} value={value} onChange={onChange} />
        </Field>
      );
    case "bool":
      return (
        <View style={[fs.rowBetween, { paddingVertical: 4 }]}>
          <Text style={fs.text}>{f.label}</Text>
          <Switch value={value === "true"} onValueChange={(on) => onChange(on ? "true" : "false")} trackColor={{ true: ACCENT }} />
        </View>
      );
    case "date":
      return (
        <Field label={label}>
          <DateField value={value} onChange={onChange} clearable />
        </Field>
      );
    case "int":
    case "float":
      return (
        <Field label={label} hint={f.hint}>
          <Input value={value} onChangeText={(t) => onChange(t.replace(f.kind === "int" ? /[^0-9-]/g : /[^0-9.-]/g, ""))} keyboardType={f.kind === "int" ? "number-pad" : "decimal-pad"} />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={f.hint}>
          <Input value={value} onChangeText={onChange} autoCapitalize="none" />
          {f.options?.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingTop: 6 }} keyboardShouldPersistTaps="handled">
              {f.options.map((o) => (
                <Chip key={o} label={o} on={value === o} onPress={() => onChange(value === o ? "" : o)} />
              ))}
            </ScrollView>
          ) : null}
        </Field>
      );
  }
}

/** Tap to pick, tap again to clear. */
export function ChipRow({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => (
        <Chip key={o.value} label={o.label} on={value === o.value} onPress={() => onChange(value === o.value ? "" : o.value)} />
      ))}
    </View>
  );
}
