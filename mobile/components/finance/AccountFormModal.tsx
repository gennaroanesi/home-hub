// Add or edit a finance account — the phone's twin of the web's account
// form (pages/finance/accounts.tsx). Form shape, validation, the written row,
// the SimpleFIN picker grouping and the delete guard all come from root
// lib/finance/account-form.ts; writes go straight to homeFinanceAccount
// through the mobile data client, like the web.

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getClient } from "../../lib/amplify";
import { usePeople } from "../../lib/use-people";
import { PeoplePicker } from "../PeoplePicker";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, RETIREMENT_TYPES, RETIREMENT_TYPE_LABELS, isInvested } from "../../../lib/finance/accounts";
import {
  ACCOUNT_HAS_TRANSACTIONS,
  accountFormFrom,
  accountHasTransactions,
  accountTypeFields,
  deleteAccountWithHoldings,
  newAccountForm,
  parseSimplefinListing,
  pickSimplefinAccount,
  saveAccountForm,
  typeSimplefinAccountId,
  simplefinInstitutions,
  simplefinPickerGroups,
  EMPTY_SF_FILTER,
  type AccountForm,
  type SfListing,
  type SfPickerFilter,
} from "../../../lib/finance/account-form";
import { SIMPLEFIN_CONNECTIONS } from "../../../lib/finance/simplefin-connections";
import { financePeople } from "../../../lib/finance/ledger";
import { Field, FormSheet, Input, ff } from "./form";
import { ACCENT, Chip, fs } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LIST_SIMPLEFIN = /* GraphQL */ `
  mutation ListSimplefinAccounts {
    listSimplefinAccounts
  }
`;

const errMsg = (e: any) => e?.errors?.[0]?.message ?? (e instanceof Error ? e.message : String(e));

/** Signed amount as typed ("-12.5"): digits, one dot, a leading minus. */
const cleanSigned = (v: string) => {
  const neg = v.trim().startsWith("-");
  const c = v.replace(/[^0-9.]/g, "");
  const [a, ...rest] = c.split(".");
  return (neg ? "-" : "") + (rest.length ? `${a}.${rest.join("")}` : a);
};
const cleanDecimal = (v: string) => cleanSigned(v).replace(/^-/, "");

export function AccountFormModal({
  visible,
  account,
  accounts,
  onClose,
  onSaved,
}: {
  visible: boolean;
  /** The homeFinanceAccount row to edit, or null for a new account. */
  account: any | null;
  /** Every account row (clash check, sort order). */
  accounts: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { people } = usePeople();
  const [form, setForm] = useState<AccountForm>(() => newAccountForm(accounts.length));
  const [busy, setBusy] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  // What the picker last listed, so a typed id takes its connection too.
  const [listed, setListed] = useState<SfListing["accounts"]>([]);

  useEffect(() => {
    if (visible) setForm(account ? accountFormFrom(account) : newAccountForm(accounts.length));
    // Only when the sheet opens or the account changes, not on list reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, account]);

  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const show = accountTypeFields(form.type);

  async function save() {
    setBusy(true);
    try {
      const invalid = await saveAccountForm(getClient(), form, accounts);
      if (invalid) return Alert.alert(invalid);
      onSaved();
    } catch (e) {
      Alert.alert("Couldn't save", errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const id = form.id;
    if (!id) return;
    setBusy(true);
    let has: boolean;
    try {
      has = await accountHasTransactions(getClient(), id);
    } catch (e) {
      setBusy(false);
      return Alert.alert("Couldn't check for transactions", errMsg(e));
    }
    setBusy(false);
    if (has) return Alert.alert(ACCOUNT_HAS_TRANSACTIONS.title, ACCOUNT_HAS_TRANSACTIONS.detail);
    Alert.alert(`Delete ${form.name}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await deleteAccountWithHoldings(getClient(), id);
            onSaved();
          } catch (e) {
            Alert.alert("Couldn't delete", errMsg(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <FormSheet visible={visible} title={form.id ? "Edit account" : "New account"} onClose={onClose} onSave={save} busy={busy} canSave={!!form.name.trim()}>
      <Field label="Name">
        <Input value={form.name} onChangeText={(v) => set("name", v)} placeholder="Joint checking" autoFocus={!account} />
      </Field>
      <Field label="Type">
        <View style={fs.chipRow}>
          {ACCOUNT_TYPES.map((t) => (
            <Chip key={t} label={ACCOUNT_TYPE_LABELS[t]} on={form.type === t} onPress={() => set("type", t)} />
          ))}
        </View>
      </Field>
      {show.retirementType && (
        <Field label="Retirement account">
          <View style={fs.chipRow}>
            {RETIREMENT_TYPES.map((t) => (
              <Chip key={t} label={RETIREMENT_TYPE_LABELS[t]} on={form.retirementType === t} onPress={() => set("retirementType", t)} />
            ))}
          </View>
        </Field>
      )}
      <Field label="Institution">
        <Input value={form.institution} onChangeText={(v) => set("institution", v)} />
      </Field>
      <Field label="Last 4">
        <Input value={form.last4} maxLength={4} keyboardType="number-pad" onChangeText={(v) => set("last4", v.replace(/\D/g, ""))} />
      </Field>
      <Field label="Current balance" hint={form.simplefinAccountId ? "Overwritten by each sync" : isInvested(form.type) ? "Total value, positions included" : "Negative for money owed"}>
        <Input value={form.currentBalance} onChangeText={(v) => set("currentBalance", cleanSigned(v))} keyboardType="numbers-and-punctuation" placeholder="0" />
      </Field>
      <Field label="Sort order">
        <Input value={form.sortOrder} onChangeText={(v) => set("sortOrder", v.replace(/[^0-9-]/g, ""))} keyboardType="numbers-and-punctuation" />
      </Field>
      {show.minBalance && (
        <Field label="Minimum balance (buffer)" hint="Warn when scheduled debits would take it below this">
          <Input value={form.minBalance} onChangeText={(v) => set("minBalance", cleanDecimal(v))} keyboardType="decimal-pad" placeholder="$" />
        </Field>
      )}
      {show.creditLimit && (
        <Field label="Credit limit">
          <Input value={form.creditLimit} onChangeText={(v) => set("creditLimit", cleanDecimal(v))} keyboardType="decimal-pad" placeholder="$" />
        </Field>
      )}
      {show.statementDueDay && (
        <Field label="Statement due day">
          <Input value={form.statementDueDay} onChangeText={(v) => set("statementDueDay", v.replace(/\D/g, ""))} keyboardType="number-pad" maxLength={2} placeholder="1–31" />
        </Field>
      )}
      {show.apr && (
        <Field label="APR (%)">
          <Input value={form.apr} onChangeText={(v) => set("apr", cleanDecimal(v))} keyboardType="decimal-pad" placeholder="%" />
        </Field>
      )}
      {show.apy && (
        <Field label="APY (%)">
          <Input value={form.apy} onChangeText={(v) => set("apy", cleanDecimal(v))} keyboardType="decimal-pad" placeholder="%" />
        </Field>
      )}

      <Field label="Owners" hint="None selected = joint (household) account.">
        <PeoplePicker people={financePeople(people, [...form.ownerPersonIds, ...accounts.flatMap((a) => a.ownerPersonIds ?? [])])} selectedIds={form.ownerPersonIds} onChange={(ids) => set("ownerPersonIds", ids)} placeholder="Joint" title="Owners" disabled={busy} />
      </Field>

      <View style={ff.box}>
        <Text style={ff.label}>SimpleFIN</Text>
        <Input value={form.simplefinAccountId} onChangeText={(v) => setForm((f) => typeSimplefinAccountId(f, v, listed))} placeholder="ACT-…" autoCapitalize="none" autoCorrect={false} />
        <Text style={ff.hint}>{isInvested(form.type) ? "Syncs value, positions and transactions 3×/day; its transactions stay out of the budget" : "Linked accounts sync balance and transactions 3×/day"}</Text>
        <Text style={ff.label}>Connection</Text>
        <View style={fs.chipRow}>
          {SIMPLEFIN_CONNECTIONS.map((c) => (
            <Chip key={c.key} label={c.label} on={form.simplefinConnection === c.key} onPress={() => set("simplefinConnection", c.key)} />
          ))}
        </View>
        <Pressable style={ff.smallBtn} onPress={() => setPickOpen(true)}>
          <Ionicons name="link" size={14} color={ACCENT} />
          <Text style={ff.smallBtnText}>Pick</Text>
        </Pressable>
      </View>

      <Field label="Notes">
        <Input value={form.notes} onChangeText={(v) => set("notes", v)} multiline />
      </Field>
      <View style={ff.box}>
        <View style={ff.switchRow}>
          <Text style={fs.textFlex}>Active</Text>
          <Switch value={form.active} onValueChange={(v) => set("active", v)} />
        </View>
      </View>
      {form.id && (
        <Pressable style={ff.dangerBtn} onPress={remove} disabled={busy}>
          <Text style={ff.dangerText}>Delete account</Text>
        </Pressable>
      )}

      <SimplefinPickSheet
        visible={pickOpen}
        form={form}
        onClose={() => setPickOpen(false)}
        onListed={setListed}
        onPick={(s) => {
          setForm((f) => pickSimplefinAccount(f, s));
          setPickOpen(false);
        }}
      />
    </FormSheet>
  );
}

/** "Link a SimpleFIN account": listSimplefinAccounts grouped by whose connection it's on. */
function SimplefinPickSheet({ visible, form, onClose, onListed, onPick }: { visible: boolean; form: AccountForm; onClose: () => void; onListed: (accounts: SfListing["accounts"]) => void; onPick: (s: SfListing["accounts"][number]) => void }) {
  const [loading, setLoading] = useState(false);
  const [listing, setListing] = useState<SfListing>({ accounts: [], connections: [], error: null });
  // Same filter as the web picker (lib/finance/account-form.ts): words over name / bank / id,
  // whose connection, which bank, hide linked; the current pick always stays listed.
  const [filter, setFilter] = useState<SfPickerFilter>(EMPTY_SF_FILTER);
  const setF = (patch: Partial<SfPickerFilter>) => setFilter((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setFilter(EMPTY_SF_FILTER);
    setLoading(true);
    setListing({ accounts: [], connections: [], error: null });
    (async () => {
      let out: SfListing;
      try {
        const r: any = await getClient().graphql({ query: LIST_SIMPLEFIN });
        if (r.errors?.length) throw new Error(r.errors[0].message);
        out = parseSimplefinListing(r.data?.listSimplefinAccounts);
      } catch (e) {
        out = { accounts: [], connections: [], error: errMsg(e) };
      }
      if (!live) return;
      setListing(out);
      onListed(out.accounts);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ff.screen}>
        <View style={ff.header}>
          <View style={{ width: 50 }} />
          <Text style={ff.headerTitle} numberOfLines={1}>
            Link a SimpleFIN account
          </Text>
          <Pressable onPress={onClose} hitSlop={8} style={{ width: 50, alignItems: "flex-end" }}>
            <Text style={ff.cancel}>Close</Text>
          </Pressable>
        </View>
        {!loading && !listing.error && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: "#eee", paddingBottom: 10 }}>
            <Input
              value={filter.query ?? ""}
              onChangeText={(v) => setF({ query: v })}
              placeholder="Search name, bank or id"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
              {[{ key: null as string | null, label: "Both" }, ...SIMPLEFIN_CONNECTIONS.map((c) => ({ key: c.key as string | null, label: c.label }))].map((c) => (
                <Chip key={c.key ?? "all"} label={c.label} on={(filter.connection ?? null) === c.key} onPress={() => setF({ connection: c.key })} />
              ))}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
              <Chip label="Any bank" on={!filter.institution} onPress={() => setF({ institution: null })} />
              {simplefinInstitutions(listing.accounts).map((i) => (
                <Chip key={i} label={i} on={filter.institution === i} onPress={() => setF({ institution: filter.institution === i ? null : i })} />
              ))}
            </ScrollView>
            <View style={fs.rowBetween}>
              <Text style={fs.text}>Hide linked</Text>
              <Switch value={!!filter.hideLinked} onValueChange={(v) => setF({ hideLinked: v })} />
            </View>
          </View>
        )}
        <ScrollView contentContainerStyle={ff.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <Text style={fs.muted}>Names only; balances and activity are pulled only for the accounts linked here. One list per person&apos;s SimpleFIN connection.</Text>
          {loading ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : listing.error ? (
            <Text style={[fs.text, fs.danger]}>{listing.error}</Text>
          ) : (
            simplefinPickerGroups(listing, form, filter).map((conn) => (
              <View key={conn.key} style={ff.field}>
                <Text style={ff.label}>
                  {conn.label}&apos;s SimpleFIN
                  {conn.ok && conn.total > 0 && (
                    <Text style={fs.muted}>  {conn.rows.length === conn.total ? conn.total : `${conn.rows.length} of ${conn.total}`}</Text>
                  )}
                </Text>
                {!conn.ok ? (
                  <Text style={[fs.muted, fs.warn]}>{conn.error}</Text>
                ) : conn.total === 0 ? (
                  <Text style={fs.muted}>No accounts on this connection yet.</Text>
                ) : conn.rows.length === 0 ? (
                  <Text style={fs.muted}>Nothing matches here.</Text>
                ) : (
                  <View style={[ff.box, { gap: 0, paddingVertical: 4 }]}>
                    {conn.rows.map((s, i) => (
                      <View key={s.id} style={[fs.rowBetween, { paddingVertical: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: "#f0f0f0" }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={[fs.text, { fontWeight: "500" }]} numberOfLines={1}>
                            {s.name}
                          </Text>
                          <Text style={fs.muted} numberOfLines={2}>
                            {s.institution}
                            {s.mappedTo ? ` · linked to ${s.mappedTo.name}` : ""}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => onPick(s)}
                          disabled={s.taken}
                          hitSlop={6}
                          style={({ pressed }) => [
                            { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: ACCENT },
                            s.selected && { backgroundColor: ACCENT },
                            s.taken && { borderColor: "#ccc" },
                            pressed && fs.pressed,
                          ]}
                        >
                          <Text style={{ fontSize: 13, fontWeight: "600", color: s.selected ? "#fff" : s.taken ? "#aaa" : ACCENT }}>{s.selected ? "Selected" : s.taken ? "Taken" : "Use"}</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
