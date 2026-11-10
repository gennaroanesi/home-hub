"use client";

// The week planner's section cards (pages/week.tsx): finance, to-do,
// travel, care, birthdays and errands, from get_week_plan's `sections`
// (lib/week-sections.ts). Read-only; each card links to the page where
// the thing is managed.

import React from "react";
import NextLink from "next/link";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { FaBirthdayCake, FaClipboardList, FaHeartbeat, FaMoneyBillWave, FaPlane, FaPlus, FaTasks } from "react-icons/fa";

import type { OpCallResult } from "@/lib/ops-client";

type Plan = Extract<OpCallResult<"get_week_plan">, { result: unknown }>["result"];
type Sections = Plan["sections"];

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
const dayDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
function time(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}
const money = (n: number, cents = false) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;

function AddButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button type="button" onClick={onPress} className="text-xs text-primary flex items-center gap-1">
      <FaPlus className="text-[10px]" /> {label}
    </button>
  );
}

/** Tick to complete; disabled while saving. */
function DoneBox({ onDone }: { onDone: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <input
      type="checkbox"
      aria-label="Done"
      disabled={busy}
      checked={busy}
      onChange={async () => {
        setBusy(true);
        await onDone();
        setBusy(false);
      }}
      className="h-4 w-4 accent-primary shrink-0"
    />
  );
}

function Section({
  title,
  icon,
  href,
  linkLabel,
  empty,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  href?: string;
  linkLabel?: string;
  empty: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex justify-between items-center pb-1">
        <span className="font-semibold flex items-center gap-2">
          <span className="text-default-400">{icon}</span>
          {title}
        </span>
        <span className="flex items-center gap-3">
          {action}
          {href && (
            <NextLink href={href} className="text-xs text-primary">
              {linkLabel ?? "Open"} →
            </NextLink>
          )}
        </span>
      </CardHeader>
      <CardBody className="pt-0 gap-3 text-sm">{empty ? <p className="text-default-400">Nothing this week.</p> : children}</CardBody>
    </Card>
  );
}

function Sub({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase text-default-500">{label}</span>
      {children}
    </div>
  );
}

function Line({ left, right, muted, danger }: { left: React.ReactNode; right?: React.ReactNode; muted?: boolean; danger?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${muted ? "text-default-500" : ""} ${danger ? "text-danger-600" : ""}`}>
      <span className="min-w-0 truncate">{left}</span>
      {right != null && <span className="shrink-0 tabular-nums">{right}</span>}
    </div>
  );
}

/** Inline "add an item" box for a shopping list. */
function AddItem({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    const name = value.trim();
    if (!name) return;
    setBusy(true);
    await onAdd(name);
    setValue("");
    setBusy(false);
  };
  return (
    <form
      className="flex gap-2 pl-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add an item…"
        disabled={busy}
        className="flex-1 min-w-0 rounded-md border border-default-200 bg-content1 px-2 py-0.5 text-xs"
      />
      <button type="submit" disabled={busy || !value.trim()} className="text-xs text-primary disabled:text-default-300">
        Add
      </button>
    </form>
  );
}

export function WeekSectionCards({
  sections: s,
  nameOf,
  weekStart,
  onAddTask,
  onCompleteTask,
  onAddShoppingItem,
}: {
  sections: Sections;
  nameOf: (personId: string) => string;
  weekStart?: string;
  /** New task; date = the day it's for, if any. */
  onAddTask?: (date?: string) => void;
  onCompleteTask?: (task: { id: string; recurring: boolean }) => Promise<void>;
  onAddShoppingItem?: (listId: string, name: string) => Promise<void>;
}) {
  const f = s.finance;
  const people = (ids: string[]) => (ids.length ? ids.map(nameOf).join(", ") : "Household");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Section title="Money" icon={<FaMoneyBillWave />} href="/finance/scheduled" linkLabel="Scheduled" empty={!f.paydays.length && !f.scheduled.length && !f.transactions.length}>
        {f.paydays.length > 0 && (
          <Sub label="Paydays">
            {f.paydays.map((p) => (
              <Line key={p.personId + p.date} left={`${nameOf(p.personId)} · ${dayDate(p.date)}`} right={<span className="text-success-600">~{money(p.usualNet)}</span>} />
            ))}
          </Sub>
        )}
        {f.scheduled.length > 0 && (
          <Sub label={`Scheduled · ${money(f.scheduledOut)} out${f.scheduledIn ? ` · ${money(f.scheduledIn)} in` : ""}`}>
            {f.scheduled.map((x) => (
              <Line
                key={x.id + x.date}
                left={
                  <>
                    <span className="text-default-500 mr-2">{day(x.date)}</span>
                    {x.description}
                    {x.autopay && <span className="text-default-400"> · autopay</span>}
                  </>
                }
                right={<span className={x.amount > 0 ? "text-success-600" : ""}>{money(x.amount, true)}</span>}
              />
            ))}
          </Sub>
        )}
        {f.transactions.length > 0 && (
          <Sub label="Posted">
            {f.transactions.slice(0, 8).map((t) => (
              <Line
                key={t.id}
                muted={t.pending}
                left={
                  <>
                    <span className="text-default-500 mr-2">{day(t.date)}</span>
                    {t.description}
                    {t.pending && <span className="text-default-400"> · pending</span>}
                  </>
                }
                right={<span className={t.amount > 0 ? "text-success-600" : ""}>{money(t.amount, true)}</span>}
              />
            ))}
            {f.transactions.length > 8 && (
              <NextLink href="/finance/transactions" className="text-xs text-primary">
                +{f.transactions.length - 8} more
              </NextLink>
            )}
          </Sub>
        )}
      </Section>

      <Section
        title="To do"
        icon={<FaTasks />}
        href="/tasks"
        linkLabel="Tasks"
        empty={!s.todo.tasks.length && !s.todo.reminders.length && !onAddTask}
        action={onAddTask && <AddButton label="Task" onPress={() => onAddTask(weekStart)} />}
      >
        {s.todo.tasks.length === 0 && s.todo.reminders.length === 0 && <p className="text-default-400">Nothing due this week.</p>}
        {s.todo.tasks.length > 0 && (
          <Sub label="Tasks">
            {s.todo.tasks.map((t) => (
              <div key={t.occurrenceId ?? t.id} className="flex items-center gap-2">
                {onCompleteTask && <DoneBox onDone={() => onCompleteTask({ id: t.id, recurring: t.recurring })} />}
                <div className="flex-1 min-w-0">
                  <Line
                    danger={t.overdue}
                    left={
                      <>
                        <span className={`mr-2 ${t.overdue ? "" : "text-default-500"}`}>{t.overdue ? "overdue" : day(t.date)}</span>
                        {t.title}
                      </>
                    }
                    right={<span className="text-default-500 text-xs">{people(t.personIds)}</span>}
                  />
                </div>
              </div>
            ))}
          </Sub>
        )}
        {s.todo.reminders.length > 0 && (
          <Sub label="Reminders">
            {s.todo.reminders.map((r) => {
              const first = new Date(r.times[0]);
              return (
                <Line
                  key={r.id}
                  left={r.name}
                  right={
                    <span className="text-default-500 text-xs">
                      {r.count > 1 ? `${r.count}× from ` : ""}
                      {first.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}
                      {" · "}
                      {r.group ? "group" : r.personId ? nameOf(r.personId) : ""}
                    </span>
                  }
                />
              );
            })}
          </Sub>
        )}
      </Section>

      <Section title="Travel" icon={<FaPlane />} href="/trips" linkLabel="Trips" empty={!s.travel.trips.length}>
        {s.travel.trips.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <NextLink href={`/trips/${t.id}`} className="font-medium hover:underline">
                {t.name}
              </NextLink>
              <span className="text-default-500">
                {dayDate(t.startDate)} – {dayDate(t.endDate)} · {people(t.participantIds)}
              </span>
              {t.checklist && (
                <Chip size="sm" variant="flat" color={t.checklist.done < t.checklist.total ? "warning" : "success"}>
                  checklist {t.checklist.done}/{t.checklist.total}
                </Chip>
              )}
            </div>
            {s.travel.legs
              .filter((l) => l.tripName === t.name)
              .map((l) => (
                <Line key={l.id} left={<span className="pl-3">{l.label}</span>} right={<span className="text-default-500">{day(l.date)} {time(l.time)}</span>} />
              ))}
            {s.travel.reservations
              .filter((r) => r.tripName === t.name)
              .map((r) => (
                <Line key={r.id} left={<span className="pl-3">{r.name}</span>} right={<span className="text-default-500">{day(r.date)} {time(r.time)}</span>} />
              ))}
          </div>
        ))}
      </Section>

      <Section title="Care" icon={<FaHeartbeat />} href="/health" linkLabel="Health" empty={!s.care.pets.length && !s.care.visits.length && !s.care.pregnancy.length}>
        {s.care.visits.length > 0 && (
          <Sub label="Appointments">
            {s.care.visits.map((v) => (
              <Line key={v.id} left={`${nameOf(v.personId)} · ${v.title}`} right={<span className="text-default-500">{day(v.date)} {time(v.time)}</span>} />
            ))}
          </Sub>
        )}
        {s.care.pregnancy.map((p) => (
          <Sub key={p.personId} label={`Pregnancy · ${nameOf(p.personId)}${p.weeks ? ` · ${p.weeks} on Monday` : ""}`}>
            {p.items.length === 0 && <span className="text-default-400">Nothing due.</span>}
            {p.items.map((i) => (
              <Line
                key={i.id}
                danger={i.urgency === "OVERDUE"}
                left={i.title}
                right={
                  <span className="text-xs text-default-500">
                    {i.urgency === "BOOKED" && i.scheduledAt
                      ? `booked ${new Date(i.scheduledAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`
                      : i.urgency === "OVERDUE"
                        ? `was due by ${i.windowEnd}`
                        : i.urgency === "CONFIRM"
                          ? "did it happen?"
                          : `window ${i.windowStart} – ${i.windowEnd}`}
                  </span>
                }
              />
            ))}
          </Sub>
        ))}
        {s.care.pets.length > 0 && (
          <Sub label="Pets">
            {s.care.pets.map((p, i) => (
              <Line key={i} danger={p.overdue} left={p.title} right={p.date ? <span className="text-default-500">{p.overdue ? p.date : day(p.date)}</span> : undefined} />
            ))}
          </Sub>
        )}
      </Section>

      <Section title="Birthdays" icon={<FaBirthdayCake />} href="/admin/people" linkLabel="People" empty={!s.occasions.length}>
        {s.occasions.map((o) => (
          <Line key={o.personId} left={`${o.name}${o.age ? ` turns ${o.age}` : ""}`} right={<span className="text-default-500">{dayDate(o.date)}</span>} />
        ))}
      </Section>

      <Section title="Errands" icon={<FaClipboardList />} href="/shopping" linkLabel="Shopping" empty={!s.errands.shopping.length && !s.errands.checklists.length}>
        {s.errands.shopping.length > 0 && (
          <Sub label="Shopping">
            {s.errands.shopping.map((l) => (
              <div key={l.listId} className="flex flex-col gap-1">
                <Line
                  left={
                    <>
                      {l.emoji ? `${l.emoji} ` : ""}
                      <span className="font-medium">{l.name}</span>
                      <span className="text-default-500"> · {l.items.join(", ")}{l.open > l.items.length ? "…" : ""}</span>
                    </>
                  }
                  right={<span className="text-default-500">{l.open}</span>}
                />
                {onAddShoppingItem && <AddItem onAdd={(name) => onAddShoppingItem(l.listId, name)} />}
              </div>
            ))}
          </Sub>
        )}
        {s.errands.checklists.length > 0 && (
          <Sub label="Checklists">
            {s.errands.checklists.map((c) => (
              <Line key={c.id} left={`${c.name}${c.forName ? ` · ${c.forName}` : ""}`} right={<span className="text-default-500">{c.done}/{c.total}</span>} />
            ))}
          </Sub>
        )}
      </Section>
    </div>
  );
}
