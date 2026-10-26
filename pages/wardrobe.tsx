"use client";

// Per-person wardrobe: closet grid (with multi-photo items), saved looks,
// and the outfit suggester. Each household member has their own category
// list and style brief (homeWardrobeProfile). Separate from /inventory on
// purpose: clothing here carries styling data the suggester reasons over.

import React, { useEffect, useMemo, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner, addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { FaCog, FaMagic, FaPlus, FaTshirt } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { DateInput } from "@/components/date-input";
import { householdMembers } from "@/lib/household";
import { listAllPages } from "@/lib/list-all";
import { resolveCurrentPerson } from "@/lib/current-person";
import { photoUrl } from "@/lib/image-loader";
import {
  WARDROBE_STATUSES,
  WARDROBE_STATUS_LABELS,
  categoriesFor,
  mainImage,
  type WardrobeStatus,
} from "@/lib/wardrobe";
import type { Schema } from "@/amplify/data/resource";
import {
  PhotoCarousel,
  StatusChip,
  Swatch,
  type WardrobeItem,
  type WardrobeLook,
  type WardrobeProfile,
} from "@/components/wardrobe/shared";
import { ItemModal } from "@/components/wardrobe/item-modal";
import { LookModal, type LookDraft } from "@/components/wardrobe/look-modal";
import { ProfileModal } from "@/components/wardrobe/profile-modal";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type View = "CLOSET" | "LOOKS" | "SUGGEST";

interface Suggestion {
  title: string;
  palette?: string | null;
  occasion?: string | null;
  itemIds?: (string | null)[] | null;
  why?: string | null;
  wishlistItemIds?: (string | null)[] | null;
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function WardrobePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);
  const [personId, setPersonId] = useState("");
  const [profiles, setProfiles] = useState<WardrobeProfile[]>([]);
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [looks, setLooks] = useState<WardrobeLook[]>([]);

  const [view, setView] = useState<View>("CLOSET");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<WardrobeStatus | "OWNED" | "">("OWNED");
  const [search, setSearch] = useState("");

  const [itemOpen, setItemOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WardrobeItem | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  const [editingLook, setEditingLook] = useState<WardrobeLook | null>(null);
  const [lookDraft, setLookDraft] = useState<LookDraft | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
      } catch {
        router.push("/login");
        return;
      }
      await loadAll();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ?person=<id> deep link (the query isn't ready on the first render of a
  // statically optimized page, so this runs once the router is).
  useEffect(() => {
    if (router.isReady && typeof router.query.person === "string") setPersonId(router.query.person);
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    try {
      const [ppl, prof, it, lk, me] = await Promise.all([
        listAllPages<Person>(client.models.homePerson),
        listAllPages<WardrobeProfile>(client.models.homeWardrobeProfile),
        listAllPages<WardrobeItem>(client.models.homeWardrobeItem),
        listAllPages<WardrobeLook>(client.models.homeWardrobeLook),
        resolveCurrentPerson<Person>(client),
      ]);
      const members = householdMembers(ppl);
      setPeople(members.length ? members : ppl);
      setProfiles(prof);
      setItems(it);
      setLooks(lk);
      setPersonId((cur) => {
        if (cur) return cur;
        const q = typeof router.query.person === "string" ? router.query.person : "";
        return q || me?.id || members[0]?.id || "";
      });
    } catch (err) {
      console.error("Failed to load wardrobe:", err);
      addToast({ title: "Couldn't load the wardrobe", color: "danger" });
    } finally {
      setLoading(false);
    }
  }

  const person = people.find((p) => p.id === personId) ?? null;
  const profile = profiles.find((p) => p.personId === personId) ?? null;
  const mine = useMemo(() => items.filter((i) => i.ownerPersonId === personId), [items, personId]);
  const myLooks = useMemo(
    () => looks.filter((l) => l.ownerPersonId === personId).sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    [looks, personId],
  );
  const categories = useMemo(() => categoriesFor(profile?.categories, mine), [profile, mine]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const shown = mine.filter((i) => {
    if (category && i.category !== category) return false;
    const s = i.status ?? "KEEP";
    if (status === "OWNED" && (s === "WISHLIST" || s === "RETIRE")) return false;
    if (status && status !== "OWNED" && s !== status) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const hay = [i.name, i.brand, i.color, i.fabric, i.notes, i.category].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const groups = categories.map((c) => [c, shown.filter((i) => i.category === c)] as const).filter(([, l]) => l.length);

  function pickPerson(id: string) {
    setPersonId(id);
    setCategory("");
    router.replace({ pathname: "/wardrobe", query: { person: id } }, undefined, { shallow: true });
  }

  function openItem(it: WardrobeItem | null) {
    setEditingItem(it);
    setItemOpen(true);
  }
  function openLook(l: WardrobeLook | null, draft: LookDraft | null = null) {
    setEditingLook(l);
    setLookDraft(draft);
    setLookOpen(true);
  }

  async function woreToday(itemIds: string[], lookId?: string | null) {
    const date = todayYmd();
    try {
      const r = await client.models.homeWardrobeWear.create({ personId, date, itemIds, lookId: lookId ?? null });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      await Promise.all(itemIds.map((id) => client.models.homeWardrobeItem.update({ id, lastWornOn: date })));
      addToast({ title: "Logged as worn today", color: "success" });
      loadAll();
    } catch (err: any) {
      addToast({ title: "Couldn't log it", description: err?.message ?? String(err), color: "danger" });
    }
  }

  const counts = {
    owned: mine.filter((i) => i.status !== "WISHLIST" && i.status !== "RETIRE").length,
    wish: mine.filter((i) => i.status === "WISHLIST").length,
    photos: mine.filter((i) => mainImage(i)).length,
  };

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
          <div className="flex items-center gap-2">
            <FaTshirt className="text-default-500" />
            <h1 className="text-2xl font-bold">Wardrobe</h1>
          </div>
          <div className="flex gap-2">
            {person && (
              <Button size="sm" variant="flat" startContent={<FaCog size={11} />} onPress={() => setProfileOpen(true)}>
                Closet settings
              </Button>
            )}
            {view === "LOOKS" ? (
              <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => openLook(null)} isDisabled={!person}>
                New look
              </Button>
            ) : (
              <Button size="sm" color="primary" startContent={<FaPlus />} onPress={() => openItem(null)} isDisabled={!person}>
                Add item
              </Button>
            )}
          </div>
        </div>

        {/* Person switcher */}
        <div className="flex flex-wrap gap-2 mb-4">
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickPerson(p.id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm border ${
                p.id === personId ? "border-primary bg-primary text-primary-foreground" : "border-default-200 bg-default-50 text-default-700"
              }`}
            >
              {p.emoji && <span>{p.emoji}</span>}
              {p.name}
            </button>
          ))}
        </div>

        {/* View tabs */}
        <div className="flex gap-1 mb-5 border-b border-default-200">
          {(
            [
              ["CLOSET", `Closet · ${counts.owned}`],
              ["LOOKS", `Looks · ${myLooks.length}`],
              ["SUGGEST", "Suggest an outfit"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setView(k)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 ${view === k ? "border-primary text-foreground font-medium" : "border-transparent text-default-500"}`}
            >
              {k === "SUGGEST" && <FaMagic className="inline mr-1" size={11} />}
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        ) : !person ? (
          <p className="text-default-500">No household members found.</p>
        ) : view === "CLOSET" ? (
          <>
            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <Input
                size="sm"
                aria-label="Search"
                placeholder="Search name, brand, color, fabric…"
                value={search}
                onValueChange={setSearch}
                isClearable
                onClear={() => setSearch("")}
              />
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              <Chip on={!category} onClick={() => setCategory("")} label="All" count={mine.length} />
              {categories.map((c) => (
                <Chip key={c} on={category === c} onClick={() => setCategory(c)} label={c} count={mine.filter((i) => i.category === c).length} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 mb-6">
              <Chip on={status === "OWNED"} onClick={() => setStatus("OWNED")} label="Wearing" />
              <Chip on={status === ""} onClick={() => setStatus("")} label="Everything" />
              {WARDROBE_STATUSES.map((s) => (
                <Chip key={s} on={status === s} onClick={() => setStatus(s)} label={WARDROBE_STATUS_LABELS[s]} count={mine.filter((i) => (i.status ?? "KEEP") === s).length} />
              ))}
            </div>
            <p className="text-xs text-default-400 mb-4">
              {counts.owned} owned · {counts.wish} on the wishlist · {counts.photos} of {mine.length} have photos
            </p>

            {!groups.length ? (
              <div className="border border-dashed border-default-300 rounded-lg p-10 text-center text-default-500">
                {mine.length ? "Nothing matches these filters." : "Nothing here yet. Use Add item to start this closet."}
              </div>
            ) : (
              groups.map(([c, list]) => (
                <section key={c} className="mb-8">
                  <h2 className="text-lg font-semibold mb-3">
                    {c} <span className="text-xs text-default-400 font-normal">{list.length}</span>
                  </h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {list
                      .slice()
                      .sort((a, b) => (a.brand ?? "").localeCompare(b.brand ?? "") || a.name.localeCompare(b.name))
                      .map((it) => (
                        <ItemCard key={it.id} item={it} onOpen={() => openItem(it)} />
                      ))}
                  </div>
                </section>
              ))
            )}
          </>
        ) : view === "LOOKS" ? (
          myLooks.length ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {myLooks.map((l) => (
                <LookCard
                  key={l.id}
                  title={l.title}
                  occasion={l.occasion}
                  palette={l.palette}
                  note={l.note}
                  itemIds={l.itemIds}
                  byId={byId}
                  onOpenItem={openItem}
                  actions={
                    <>
                      <Button size="sm" variant="flat" onPress={() => woreToday(((l.itemIds ?? []) as string[]).filter(Boolean), l.id)}>
                        Wore it today
                      </Button>
                      <Button size="sm" variant="light" onPress={() => openLook(l)}>
                        Edit
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-default-300 rounded-lg p-10 text-center text-default-500">
              No looks yet. Build one with New look, or save one from the suggester.
            </div>
          )
        ) : (
          <SuggestPanel
            personId={personId}
            personName={person.name}
            byId={byId}
            onOpenItem={openItem}
            onSave={(s) => openLook(null, { ...s, itemIds: ((s.itemIds ?? []) as string[]).filter(Boolean), source: "SUGGESTED" })}
            onWear={(s) => woreToday(((s.itemIds ?? []) as string[]).filter(Boolean))}
          />
        )}
      </div>

      {person && (
        <>
          <ItemModal
            isOpen={itemOpen}
            onClose={() => setItemOpen(false)}
            editing={editingItem}
            ownerPersonId={person.id}
            categories={categories}
            defaultCategory={category || undefined}
            defaultStatus={status && status !== "OWNED" ? status : undefined}
            onSaved={loadAll}
          />
          <LookModal
            isOpen={lookOpen}
            onClose={() => setLookOpen(false)}
            editing={editingLook}
            draft={lookDraft}
            ownerPersonId={person.id}
            items={mine}
            categories={categories}
            nextSortOrder={(myLooks[myLooks.length - 1]?.sortOrder ?? myLooks.length) + 1}
            onSaved={loadAll}
          />
          <ProfileModal
            isOpen={profileOpen}
            onClose={() => setProfileOpen(false)}
            personId={person.id}
            personName={person.name}
            profile={profile}
            categories={categories}
            onSaved={loadAll}
          />
        </>
      )}
    </DefaultLayout>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Chip({ on, onClick, label, count }: { on: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-0.5 rounded-full text-sm ${on ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"}`}
    >
      {label}
      {count != null && <span className="opacity-70 ml-1 text-xs">{count}</span>}
    </button>
  );
}

function ItemCard({ item, onOpen }: { item: WardrobeItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left rounded-lg border border-default-200 bg-content1 overflow-hidden hover:border-primary transition-colors flex flex-col"
    >
      <PhotoCarousel item={item} className="aspect-[4/3]" width={480} />
      <div className="p-3 flex flex-col gap-1 min-w-0">
        {item.brand && <span className="text-[10px] uppercase tracking-wider text-default-400 truncate">{item.brand}</span>}
        <span className="text-sm font-medium leading-snug line-clamp-2">{item.name}</span>
        <span className="flex items-center gap-1.5 text-xs text-default-500 min-w-0">
          <Swatch hex={item.colorHex} />
          <span className="truncate">{[item.color, item.size].filter(Boolean).join(" · ") || "No color set"}</span>
        </span>
        <span className="flex items-center gap-1.5 mt-1">
          <StatusChip status={item.status} />
          {item.lastWornOn && <span className="text-[10px] text-default-400">worn {item.lastWornOn}</span>}
        </span>
      </div>
    </button>
  );
}

function LookCard({
  title,
  occasion,
  palette,
  note,
  itemIds,
  wishlistItemIds,
  byId,
  onOpenItem,
  actions,
}: {
  title: string;
  occasion?: string | null;
  palette?: string | null;
  note?: string | null;
  itemIds?: (string | null)[] | null;
  wishlistItemIds?: (string | null)[] | null;
  byId: Map<string, WardrobeItem>;
  onOpenItem: (it: WardrobeItem) => void;
  actions?: React.ReactNode;
}) {
  const pieces = (itemIds ?? []).map((id) => (id ? byId.get(id) : undefined)).filter((x): x is WardrobeItem => !!x);
  const wish = (wishlistItemIds ?? []).map((id) => (id ? byId.get(id) : undefined)).filter((x): x is WardrobeItem => !!x);
  const future = pieces.some((p) => p.status === "WISHLIST");
  return (
    <article className="rounded-xl border border-default-200 bg-content1 p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-lg font-semibold">{title}</h3>
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            future ? "border border-dashed border-primary-400 text-primary-600" : "bg-primary-100 text-primary-700"
          }`}
        >
          {future ? "After shopping" : occasion || "Any time"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-default-400">
        <span className="flex">
          {pieces
            .map((p) => p.colorHex)
            .filter(Boolean)
            .slice(0, 4)
            .map((h, n) => (
              <span key={n} className="w-4 h-4 rounded-full border-2 border-content1 -ml-1 first:ml-0" style={{ background: h! }} />
            ))}
        </span>
        {palette}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {pieces.map((p) => {
          const k = mainImage(p);
          return (
            <button key={p.id} type="button" onClick={() => onOpenItem(p)} className="text-left min-w-0">
              <div className="relative aspect-[3/4] rounded-md overflow-hidden border border-default-200 bg-white">
                {k ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrl(k, 240)} alt={p.name} loading="lazy" className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full" style={{ background: p.colorHex ?? undefined }} />
                )}
                {p.status === "WISHLIST" && (
                  <span className="absolute left-1 top-1 text-[9px] font-semibold bg-content1 text-primary-600 border border-dashed border-primary-400 rounded-full px-1.5">
                    To buy
                  </span>
                )}
              </div>
              <p className="text-[10px] uppercase tracking-wider text-default-400 mt-1">{p.category}</p>
              <p className="text-xs leading-tight line-clamp-2">{p.name}</p>
            </button>
          );
        })}
      </div>
      {note && <p className="text-sm text-default-600">{note}</p>}
      {wish.length > 0 && (
        <p className="text-xs text-primary-600">Would be even better with: {wish.map((w) => w.name).join(", ")}</p>
      )}
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </article>
  );
}

function SuggestPanel({
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
  onSave: (s: Suggestion) => void;
  onWear: (s: Suggestion) => void;
}) {
  const [date, setDate] = useState(todayYmd());
  const [occasion, setOccasion] = useState("");
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const [context, setContext] = useState("");

  useEffect(() => {
    setResults([]);
    setContext("");
  }, [personId]);

  async function run() {
    setBusy(true);
    try {
      const { data, errors } = await client.mutations.suggestOutfit({
        personId,
        date,
        occasion: occasion.trim() || null,
        request: request.trim() || null,
        count: 3,
      });
      if (errors?.length) throw new Error(errors[0].message);
      if (data?.error && !data.suggestions?.length) throw new Error(data.error);
      setResults((data?.suggestions ?? []).filter((s): s is NonNullable<typeof s> => !!s));
      setContext(data?.context ?? "");
    } catch (err: any) {
      addToast({ title: "No suggestions", description: err?.message ?? String(err), color: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-default-200 bg-content1 p-4 flex flex-col gap-3">
        <p className="text-sm text-default-600">
          Picks outfits from {personName}&apos;s closet using the style brief in Closet settings, the day&apos;s weather and calendar, and what was worn
          in the last few days.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <DateInput label="Day" value={date} onChange={setDate} />
          <Input label="Occasion" placeholder="Office, golf, dinner out…" value={occasion} onValueChange={setOccasion} />
        </div>
        <Textarea label="Anything specific?" placeholder="Something with the chestnut boots; it's cold in the office" value={request} onValueChange={setRequest} minRows={2} />
        <div>
          <Button color="primary" startContent={!busy && <FaMagic size={12} />} onPress={run} isLoading={busy}>
            Suggest outfits
          </Button>
        </div>
      </div>
      {context && <p className="text-xs text-default-500">Based on: {context}</p>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {results.map((s, n) => (
          <LookCard
            key={n}
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
                <Button size="sm" variant="flat" color="primary" onPress={() => onSave(s)}>
                  Save as look
                </Button>
                <Button size="sm" variant="flat" onPress={() => onWear(s)}>
                  Wear it today
                </Button>
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}
