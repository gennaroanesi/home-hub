// Loads what the wardrobe screens need: household members, every profile,
// item and look (household-wide, like the web page; screens filter by
// person), and the signed-in person to start on.

import { useCallback, useEffect, useMemo, useState } from "react";

import { getClient } from "../../lib/amplify";
import { usePeople, type Person } from "../../lib/use-people";
import { usePerson } from "../../lib/use-person";
import { listAllPages } from "../../../lib/list-all";
import { categoriesFor } from "../../../lib/wardrobe";
import type { WardrobeItem, WardrobeLook, WardrobeProfile } from "./shared";

export interface WardrobeData {
  people: Person[];
  meId: string | null;
  profiles: WardrobeProfile[];
  items: WardrobeItem[];
  looks: WardrobeLook[];
  byId: Map<string, WardrobeItem>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useWardrobe(): WardrobeData {
  const { people, loading: peopleLoading } = usePeople();
  const me = usePerson();
  const [profiles, setProfiles] = useState<WardrobeProfile[]>([]);
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [looks, setLooks] = useState<WardrobeLook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const client = getClient();
    try {
      const [prof, it, lk] = await Promise.all([
        listAllPages<WardrobeProfile>(client.models.homeWardrobeProfile),
        listAllPages<WardrobeItem>(client.models.homeWardrobeItem),
        listAllPages<WardrobeLook>(client.models.homeWardrobeLook),
      ]);
      setProfiles(prof);
      setItems(it);
      setLooks(lk);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  return {
    people,
    meId: me.status === "found" ? me.person.id : null,
    profiles,
    items,
    looks,
    byId,
    loading: loading || peopleLoading,
    error,
    reload,
  };
}

/** One person's slice: profile, items, looks (in saved order) and categories. */
export function usePersonWardrobe(data: WardrobeData, personId: string) {
  const profile = useMemo(() => data.profiles.find((p) => p.personId === personId) ?? null, [data.profiles, personId]);
  const mine = useMemo(() => data.items.filter((i) => i.ownerPersonId === personId), [data.items, personId]);
  const myLooks = useMemo(
    () => data.looks.filter((l) => l.ownerPersonId === personId).sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    [data.looks, personId],
  );
  const categories = useMemo(() => categoriesFor(profile?.categories, mine), [profile, mine]);
  return { profile, mine, myLooks, categories };
}
