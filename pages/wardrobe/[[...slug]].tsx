"use client";

// Per-person wardrobe: closet grid (with multi-photo items), saved looks,
// and the outfit suggester. Each household member has their own category
// list and style brief (homeWardrobeProfile). Separate from /inventory on
// purpose: clothing here carries styling data the suggester reasons over.
//
// Route: /wardrobe/<personId>/<closet|looks|suggest>?<filters>, kept in sync
// with the page state (lib/wardrobe-route.ts) so refreshes and links land
// on the same view.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Spinner, addToast } from "@heroui/react";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
import { FaChevronDown, FaCog, FaMagic, FaPlus, FaTshirt } from "react-icons/fa";

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
import { TryOnPreview, type TryOnJob } from "@/components/wardrobe/try-on-preview";
import { wardrobeTryOnAvailable, wardrobeTryOnSetupMessage } from "@/lib/wardrobe-capabilities";
import {
  DEFAULT_WARDROBE_ROUTE,
  parseWardrobeRoute,
  wardrobeHref,
  type StatusFilter,
  type WardrobeRoute,
  type WardrobeView as View,
} from "@/lib/wardrobe-route";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];

function routeFromRouter(query: Record<string, string | string[] | undefined>): WardrobeRoute {
  const slug = query.slug;
  return parseWardrobeRoute(Array.isArray(slug) ? slug : slug ? [slug] : [], query);
}

interface Suggestion {
  previewImageKey?: string | null;
  tryOnJobId?: string | null;
  stylingInstructions?: string | null;
  generationBrief?: string | null;
  title: string;
  palette?: string | null;
  occasion?: string | null;
  itemIds?: (string | null)[] | null;
  why?: string | null;
  wishlistItemIds?: (string | null)[] | null;
}

// Every word must appear somewhere in the haystack: "navy wool" matches a
// navy merino-wool sweater, not just the literal phrase.
function matchesSearch(q: string, parts: (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
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

  const [view, setView] = useState<View>(DEFAULT_WARDROBE_ROUTE.view);
  const [category, setCategory] = useState(DEFAULT_WARDROBE_ROUTE.category);
  const [status, setStatus] = useState<StatusFilter>(DEFAULT_WARDROBE_ROUTE.status);
  const [search, setSearch] = useState(DEFAULT_WARDROBE_ROUTE.search);
  const [inLook, setInLook] = useState(DEFAULT_WARDROBE_ROUTE.inLook);
  const [lookSearch, setLookSearch] = useState(DEFAULT_WARDROBE_ROUTE.lookSearch);
  const [lookOccasion, setLookOccasion] = useState(DEFAULT_WARDROBE_ROUTE.lookOccasion);
  const [lookTryOn, setLookTryOn] = useState(DEFAULT_WARDROBE_ROUTE.lookTryOn);

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

  // URL -> state: on load (the query isn't ready on the first render of a
  // statically optimized page) and on back/forward. Skips URLs this page
  // just wrote itself.
  const lastHref = useRef("");
  const navKey = useRef(""); // "<personId>/<view>" currently in the URL
  useEffect(() => {
    if (!router.isReady || router.asPath === lastHref.current) return;
    const r = routeFromRouter(router.query);
    if (r.personId) setPersonId(r.personId);
    setView(r.view);
    setCategory(r.category);
    setStatus(r.status);
    setSearch(r.search);
    setInLook(r.inLook);
    setLookSearch(r.lookSearch);
    setLookOccasion(r.lookOccasion);
    setLookTryOn(r.lookTryOn);
    navKey.current = r.personId ? `${r.personId}/${r.view}` : "";
  }, [router.isReady, router.asPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // State -> URL. Switching person or view adds a history entry; filter and
  // search changes replace it (debounced so typing doesn't spam history).
  useEffect(() => {
    if (!router.isReady || !personId) return;
    const t = setTimeout(() => {
      const href = wardrobeHref({ personId, view, category, status, search, inLook, lookSearch, lookOccasion, lookTryOn });
      if (href === router.asPath) {
        lastHref.current = href;
        return;
      }
      const key = `${personId}/${view}`;
      const push = !!navKey.current && navKey.current !== key;
      navKey.current = key;
      lastHref.current = href;
      if (push) router.push(href, undefined, { shallow: true });
      else router.replace(href, undefined, { shallow: true });
    }, 250);
    return () => clearTimeout(t);
  }, [router.isReady, personId, view, category, status, search, inLook, lookSearch, lookOccasion, lookTryOn]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Keep the person from the URL if they exist; a stale or mistyped id
      // falls back to the signed-in person.
      const known = (id: string) => !!id && (members.length ? members : ppl).some((p) => p.id === id);
      setPersonId((cur) => {
        if (known(cur)) return cur;
        const fromUrl = routeFromRouter(router.query).personId;
        return (known(fromUrl) ? fromUrl : "") || me?.id || members[0]?.id || "";
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

  // Pieces used by at least one of this person's saved looks.
  const inLooks = useMemo(() => new Set(myLooks.flatMap((l) => (l.itemIds ?? []).filter((x): x is string => !!x))), [myLooks]);

  const shown = mine.filter((i) => {
    if (category && i.category !== category) return false;
    const s = i.status ?? "KEEP";
    if (status === "OWNED" && (s === "WISHLIST" || s === "RETIRE")) return false;
    if (status && status !== "OWNED" && s !== status) return false;
    if (inLook === "YES" && !inLooks.has(i.id)) return false;
    if (inLook === "NO" && inLooks.has(i.id)) return false;
    return matchesSearch(search, [i.name, i.brand, i.color, i.fabric, i.fit, i.size, i.styleCode, i.notes, i.category]);
  });

  // Occasion chips: distinct occasions across the looks, case-insensitive,
  // shown with the first spelling seen.
  const occasions = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const l of myLooks) {
      const o = l.occasion?.trim();
      if (!o) continue;
      const k = o.toLowerCase();
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { label: o, count: 1 });
    }
    return Array.from(m.entries()).sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));
  }, [myLooks]);

  const shownLooks = myLooks.filter((l) => {
    if (lookOccasion && (l.occasion ?? "").trim().toLowerCase() !== lookOccasion) return false;
    if (lookTryOn && !l.previewImageKey) return false;
    const pieces = (l.itemIds ?? []).map((id) => (id ? byId.get(id) : undefined));
    return matchesSearch(lookSearch, [
      l.title, l.occasion, l.palette, l.note, l.stylingInstructions,
      ...pieces.flatMap((p) => (p ? [p.brand, p.name, p.color, p.category] : [])),
    ]);
  });
  const groups = categories.map((c) => [c, shown.filter((i) => i.category === c)] as const).filter(([, l]) => l.length);

  function pickPerson(id: string) {
    setPersonId(id);
    setCategory("");
    setInLook("");
    setLookOccasion("");
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
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-10">
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
        <div className="flex gap-1 mb-5 border-b border-default-200 overflow-x-auto">
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
              className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm -mb-px border-b-2 ${view === k ? "border-primary text-foreground font-medium" : "border-transparent text-default-500"}`}
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
            <div className="flex flex-wrap gap-1.5 mb-2">
              <Chip on={status === "OWNED"} onClick={() => setStatus("OWNED")} label="Wearing" />
              <Chip on={status === ""} onClick={() => setStatus("")} label="Everything" />
              {WARDROBE_STATUSES.map((s) => (
                <Chip key={s} on={status === s} onClick={() => setStatus(s)} label={WARDROBE_STATUS_LABELS[s]} count={mine.filter((i) => (i.status ?? "KEEP") === s).length} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 mb-6">
              <Chip on={inLook === "YES"} onClick={() => setInLook(inLook === "YES" ? "" : "YES")} label="In a look" count={mine.filter((i) => inLooks.has(i.id)).length} />
              <Chip on={inLook === "NO"} onClick={() => setInLook(inLook === "NO" ? "" : "NO")} label="Not in a look" count={mine.filter((i) => !inLooks.has(i.id)).length} />
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
            <>
            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <Input
                size="sm"
                aria-label="Search looks"
                placeholder="Search title, occasion, palette, pieces…"
                value={lookSearch}
                onValueChange={setLookSearch}
                isClearable
                onClear={() => setLookSearch("")}
              />
            </div>
            <div className="flex flex-wrap gap-1.5 mb-6">
              <Chip on={!lookOccasion} onClick={() => setLookOccasion("")} label="Any occasion" count={myLooks.length} />
              {occasions.map(([k, o]) => (
                <Chip key={k} on={lookOccasion === k} onClick={() => setLookOccasion(lookOccasion === k ? "" : k)} label={o.label} count={o.count} />
              ))}
              <Chip on={lookTryOn} onClick={() => setLookTryOn((v) => !v)} label="Has try-on" count={myLooks.filter((l) => l.previewImageKey).length} />
            </div>
            {!shownLooks.length && (
              <div className="border border-dashed border-default-300 rounded-lg p-10 text-center text-default-500">Nothing matches these filters.</div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {shownLooks.map((l) => (
                <LookCard
                  key={l.id}
                  title={l.title}
                  previewImageKey={l.previewImageKey}
                  previewCollapsible
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
            </>
          ) : (
            <div className="border border-dashed border-default-300 rounded-lg p-10 text-center text-default-500">
              No looks yet. Build one with New look, or save one from the suggester.
            </div>
          )
        ) : (
          <SuggestPanel
            key={personId}
            hasReference={wardrobeTryOnAvailable && !!profile?.referenceImageKeys?.some(Boolean)}
            onSettings={() => setProfileOpen(true)}
            personId={personId}
            personName={person.name}
            byId={byId}
            onOpenItem={openItem}
            onSave={(s) => openLook(null, { ...s, note: s.why, itemIds: ((s.itemIds ?? []) as string[]).filter(Boolean), source: "SUGGESTED" })}
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
      className="h-full text-left rounded-lg border border-default-200 bg-content1 overflow-hidden hover:border-primary transition-colors flex flex-col"
    >
      <PhotoCarousel item={item} className="aspect-[4/3]" width={480} />
      {/* Every line reserves its space (brand, two name lines, footer) so all
          cards come out the same height whatever they contain. */}
      <div className="p-3 flex flex-col gap-1 min-w-0">
        <span className="h-4 text-[10px] uppercase tracking-wider text-default-400 truncate">{item.brand ?? ""}</span>
        <span className="min-h-[2.75em] text-sm font-medium leading-snug line-clamp-2">{item.name}</span>
        <span className="flex items-center gap-1.5 text-xs text-default-500 min-w-0">
          <Swatch hex={item.colorHex} />
          <span className="truncate">{[item.color, item.size].filter(Boolean).join(" · ") || "No color set"}</span>
        </span>
        <span className="h-5 flex items-center gap-1.5 mt-1">
          {/* KEEP is the default — only call out the exceptions. */}
          {item.status && item.status !== "KEEP" && <StatusChip status={item.status} />}
          {item.lastWornOn && <span className="text-[10px] text-default-400">worn {item.lastWornOn}</span>}
        </span>
      </div>
    </button>
  );
}

function LookCard({
  previewImageKey,
  previewCollapsible,
  preview,
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
  previewImageKey?: string | null;
  /** Hide the try-on behind a chevron toggle (saved looks list). */
  previewCollapsible?: boolean;
  preview?: React.ReactNode;
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
  // Older suggestions listed wishlist extras separately; skip ones already shown as pieces.
  const wish = (wishlistItemIds ?? [])
    .filter((id) => id && !(itemIds ?? []).includes(id))
    .map((id) => (id ? byId.get(id) : undefined))
    .filter((x): x is WardrobeItem => !!x);
  const future = pieces.some((p) => p.status === "WISHLIST");
  const [showPreview, setShowPreview] = useState(!previewCollapsible);
  return (
    <article className="rounded-xl border border-default-200 bg-content1 p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-lg font-semibold">{title}</h3>
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            future ? "bg-warning-100 text-warning-700 border border-warning-300" : "bg-primary-100 text-primary-700"
          }`}
        >
          {future ? "⚠ Includes pieces you don't own" : occasion || "Any time"}
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
      {previewImageKey && previewCollapsible && (
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          aria-expanded={showPreview}
          className="flex items-center justify-between gap-2 rounded-lg bg-default-100 px-3 py-2 text-sm text-default-600 hover:bg-default-200"
        >
          <span>{showPreview ? "Hide try-on" : "Show try-on"}</span>
          <FaChevronDown size={12} className={`transition-transform ${showPreview ? "rotate-180" : ""}`} />
        </button>
      )}
      {previewImageKey && showPreview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(previewImageKey, 800)} alt={`AI-generated preview of ${title}`} loading="lazy" className="w-full max-h-[70vh] sm:max-h-[600px] object-contain rounded-lg bg-default-50" />
      )}
      {preview}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {pieces.map((p) => {
          const k = mainImage(p);
          return (
            <button key={p.id} type="button" onClick={() => onOpenItem(p)} className="text-left min-w-0">
              <div
                className={`relative aspect-[3/4] rounded-md overflow-hidden bg-white ${
                  p.status === "WISHLIST" ? "border-2 border-dashed border-warning-400" : "border border-default-200"
                }`}
              >
                {k ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrl(k, 240)} alt={p.name} loading="lazy" className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full" style={{ background: p.colorHex ?? undefined }} />
                )}
                {p.status === "WISHLIST" && (
                  <span className="absolute left-1 top-1 text-[9px] font-semibold bg-warning-100 text-warning-700 border border-warning-300 rounded-full px-1.5">
                    Not owned
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
  hasReference,
  onSettings,
  personId,
  personName,
  byId,
  onOpenItem,
  onSave,
  onWear,
}: {
  hasReference: boolean;
  onSettings: () => void;
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
  const [instructions, setInstructions] = useState("");
  const [renderInstructions, setRenderInstructions] = useState("");
  const [brief, setBrief] = useState("");
  const [autoPreview, setAutoPreview] = useState(false);
  const [previewBatch, setPreviewBatch] = useState(false);
  const [batch, setBatch] = useState(0);
  const [history, setHistory] = useState<TryOnJob[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyVersion, setHistoryVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!wardrobeTryOnAvailable) return;
      try {
        const jobs = await listAllPages<TryOnJob>({ list: async (options: unknown) => {
          const list = client.models.homeWardrobeTryOn.list as unknown as (input: unknown) => Promise<{ data: TryOnJob[]; errors?: { message: string }[]; nextToken?: string | null }>;
          const response = await list(options);
          if (response.errors?.length) throw new Error(response.errors[0].message);
          return response;
        } }, { filter: { ownerPersonId: { eq: personId } } });
        if (!cancelled) {
          setHistory(jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12));
          setHistoryError("");
          if (jobs.some(job => (job.status === "QUEUED" || job.status === "PROCESSING") && Date.now() - new Date(job.updatedAt).getTime() < 10 * 60_000)) timer = setTimeout(refresh, 10_000);
        }
      } catch { if (!cancelled) setHistoryError("Couldn't load recent previews."); }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [personId, historyVersion]);

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
        request: [request.trim(), instructions.trim() && `Wearing instructions: ${instructions.trim()}`].filter(Boolean).join("\n") || null,
        count: 3,
      });
      if (errors?.length) throw new Error(errors[0].message);
      if (data?.error && !data.suggestions?.length) throw new Error(data.error);
      setResults((data?.suggestions ?? []).filter((s): s is NonNullable<typeof s> => !!s));
      setRenderInstructions(instructions.trim());
      setBrief([occasion.trim(), request.trim()].filter(Boolean).join("\n"));
      setPreviewBatch(autoPreview && hasReference);
      setBatch(b => b + 1);
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
        <Textarea label="Describe the look" placeholder="Dinner downtown, relaxed but polished. My wife is wearing an emerald dress. Use my chestnut boots…" value={request} onValueChange={setRequest} minRows={3} />
        <Textarea label="How to wear the pieces" description="These instructions also shape the try-on image." placeholder="Shirt tucked in, jacket open, trousers over boots…" value={instructions} onValueChange={setInstructions} maxLength={2000} minRows={2} />
        {!wardrobeTryOnAvailable ? null : hasReference ? <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={autoPreview} onChange={e => setAutoPreview(e.target.checked)} />Automatically preview all three outfits</label> : <div className="text-sm text-default-500">Add a reference photo to preview outfits on you. <Button size="sm" variant="light" onPress={onSettings}>Open Closet settings</Button></div>}
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
            key={`${batch}-${n}`}
            title={s.title}
            occasion={s.occasion}
            palette={s.palette}
            note={s.why}
            preview={hasReference && <TryOnPreview
              personId={personId}
              itemIds={(s.itemIds ?? []).filter((id): id is string => !!id)}
              instructions={renderInstructions}
              autoStart={previewBatch}
              onStarted={() => setHistoryVersion(v => v + 1)}
              onReady={job => setResults(current => current.map((result, index) => index === n ? { ...result, previewImageKey: job.previewImageKey, tryOnJobId: job.id } : result))}
            />}
            itemIds={s.itemIds}
            wishlistItemIds={s.wishlistItemIds}
            byId={byId}
            onOpenItem={onOpenItem}
            actions={
              <>
                <Button size="sm" variant="flat" color="primary" onPress={() => onSave({ ...s, stylingInstructions: renderInstructions, generationBrief: brief })}>
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
      {!wardrobeTryOnAvailable && <p role="status" className="text-sm text-default-500">{wardrobeTryOnSetupMessage}</p>}
      {historyError && <p role="alert" className="text-sm text-danger">{historyError}</p>}
      {history.length > 0 && <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent try-ons</h2>
        <p className="text-sm text-default-500">Previews are kept here even if you leave the page. Reusing the same clothes, reference photos and wearing instructions reuses the image.</p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {history.map(job => <LookCard key={job.id} title="Outfit preview" itemIds={job.itemIds} byId={byId} onOpenItem={onOpenItem}
            previewImageKey={job.status === "READY" ? job.previewImageKey : null}
            note={job.stylingInstructions}
            preview={job.status !== "READY" && <TryOnPreview personId={personId} itemIds={(job.itemIds ?? []).filter((id): id is string => !!id)} instructions={job.stylingInstructions ?? ""} initialJobId={job.id} onStarted={() => setHistoryVersion(v => v + 1)} onReady={() => setHistoryVersion(v => v + 1)} />}
            actions={job.status === "READY" && <Button size="sm" color="primary" variant="flat" onPress={() => onSave({ title: "My look", itemIds: job.itemIds, previewImageKey: job.previewImageKey, tryOnJobId: job.id, stylingInstructions: job.stylingInstructions })}>Save as look</Button>}
          />)}
        </div>
      </section>}
    </div>
  );
}
