// The inventory's first page on the web, like the phone's: what we own and
// what it cost, shortcuts to the wishlist / drafts / running low / past,
// tiles by category, room or person, and the recently added. Picking a
// tile sets the page's filter, which shows the list. get_inventory_overview.

import React, { useState } from "react";
import { FaBoxOpen, FaCamera, FaChevronRight, FaExclamationCircle, FaHeart, FaHome, FaLock, FaMagic, FaArchive, FaMusic, FaMicrochip, FaPaw, FaPalette, FaShoppingBasket, FaTshirt, FaUser, FaUsers, FaQuestion } from "react-icons/fa";

import type { OpOutput } from "@/lib/ops/registry";
import { formatUsd } from "@/lib/inventory";
import { photoUrl } from "@/lib/image-loader";

export type Overview = OpOutput<"get_inventory_overview">;
type Bucket = Overview["rooms"][number];
export type OverviewPick = { kind: "category" | "room" | "owner"; key: string } | { kind: "status"; key: "WISHLIST" | "DRAFT" | "PAST" | "LOW" };
type By = "category" | "room" | "owner";

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  CLOTHING: FaTshirt,
  CONSUMABLE: FaShoppingBasket,
  FIREARM: FaLock,
  AMMO: FaLock,
  FILAMENT: FaPalette,
  INSTRUMENT: FaMusic,
  PHOTOGRAPHY: FaCamera,
  ELECTRONIC: FaMicrochip,
};

export function InventoryOverview({ overview: o, onPick, onOpenItem }: { overview: Overview; onPick: (p: OverviewPick) => void; onOpenItem: (id: string) => void }) {
  const [by, setBy] = useState<By>("category");

  const shortcuts = [
    { key: "DRAFT" as const, label: "Drafts to review", n: o.statusCounts.DRAFT, Icon: FaMagic, warn: true },
    { key: "LOW" as const, label: "Running low", n: o.lowStock, Icon: FaExclamationCircle, warn: true },
    { key: "WISHLIST" as const, label: "Wishlist", n: o.statusCounts.WISHLIST, sub: o.wishlist.estimatedTotal ? `~${formatUsd(o.wishlist.estimatedTotal)}` : undefined, Icon: FaHeart },
    { key: "PAST" as const, label: "Sold & given away", n: o.statusCounts.PAST, Icon: FaArchive },
  ].filter((s) => s.n > 0);

  const tiles: Array<Bucket & { Icon: React.ComponentType<{ className?: string }>; locked?: boolean }> =
    by === "category"
      ? o.categories.filter((c) => c.depth === 0).map((c) => ({ ...c, Icon: (c.detailType && TYPE_ICON[c.detailType]) || FaBoxOpen, locked: c.private }))
      : by === "room"
        ? o.rooms.map((r) => ({ ...r, Icon: r.key === "none" ? FaQuestion : FaHome }))
        : o.owners.map((w) => ({ ...w, Icon: w.key.startsWith("pet:") ? FaPaw : w.key === "household" ? FaUsers : FaUser }));

  return (
    <div className="space-y-6">
      <p className="text-sm text-default-500">
        <span className="font-semibold text-foreground">{o.owned.count}</span> thing{o.owned.count === 1 ? "" : "s"} we own
        {o.owned.value > 0 && (
          <>
            {" "}· <span className="font-semibold text-foreground">{formatUsd(o.owned.value)}</span> paid
          </>
        )}
      </p>

      {shortcuts.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {shortcuts.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onPick({ kind: "status", key: s.key })}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-default-100 ${s.warn ? "border-warning-200 bg-warning-50" : "border-default-200 bg-default-50"}`}
            >
              <s.Icon className={s.warn ? "text-warning-600" : "text-primary"} />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{s.label}</span>
                {s.sub && <span className="block text-xs text-default-400">{s.sub}</span>}
              </span>
              <span className="font-semibold">{s.n}</span>
              <FaChevronRight className="text-default-300 text-xs" />
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {(
          [
            ["category", "Categories"],
            ["room", "Rooms"],
            ["owner", "People"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setBy(k)} className={`px-3 py-1 rounded-full text-sm ${by === k ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-600"}`}>
            {label}
          </button>
        ))}
      </div>

      {tiles.length === 0 ? (
        <p className="text-center py-12 text-default-400">Nothing here yet. Add items here, or tell Janet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onPick({ kind: by, key: t.key })}
              className="text-left rounded-lg border border-default-200 bg-default-50 overflow-hidden hover:border-primary-300 hover:shadow-sm transition"
            >
              {t.imageKey ? (
                <img src={photoUrl(t.imageKey, 400)} alt="" loading="lazy" className="w-full aspect-[5/3] object-cover bg-default-100" />
              ) : (
                <div className="w-full aspect-[5/3] bg-default-100 flex items-center justify-center">
                  <t.Icon className="text-3xl text-default-300" />
                </div>
              )}
              <div className="p-3 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold truncate">{t.label}</span>
                  {t.locked && <FaLock className="text-[10px] text-default-400 shrink-0" />}
                </div>
                <p className="text-xs text-default-500 truncate">
                  {t.count} item{t.count === 1 ? "" : "s"}
                  {t.value > 0 ? ` · ${formatUsd(t.value)}` : ""}
                </p>
                {t.wishlist > 0 && <p className="text-xs text-primary truncate">+{t.wishlist} on the wishlist</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      {o.recent.length > 0 && (
        <section>
          <h2 className="text-xs font-medium uppercase tracking-wider text-default-400 mb-2">Recently added</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {o.recent.map((i) => (
              <button key={i.id} type="button" onClick={() => onOpenItem(i.id)} className="w-28 shrink-0 text-left">
                {i.imageKeys[0] ? (
                  <img src={photoUrl(i.imageKeys[0], 240)} alt="" loading="lazy" className="w-28 h-28 rounded-md object-cover bg-default-100" />
                ) : (
                  <div className="w-28 h-28 rounded-md bg-default-100 flex items-center justify-center">
                    <FaBoxOpen className="text-2xl text-default-300" />
                  </div>
                )}
                <p className="text-sm mt-1 line-clamp-2">{i.name}</p>
                {i.status === "WISHLIST" && <p className="text-xs text-primary">Wishlist</p>}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
