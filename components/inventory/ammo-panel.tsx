"use client";

// Ammo on the inventory page (owner-only, docs/inventory-specialized.md):
// rounds on hand per caliber against each minimum, "Log use" (oldest
// purchases first, through log_ammo_use), minimums, and recent uses with
// undo. Only the signed-in owner's ammo ever reaches this.

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { addToast } from "@heroui/react";

import { DateInput } from "@/components/date-input";
import { callOp } from "@/lib/ops-client";
import type { OpOutput } from "@/lib/ops/registry";

type Summary = OpOutput<"get_ammo_summary">;

export function AmmoPanel({ client, version, onChanged }: { client: unknown; version: number; onChanged: () => void }) {
  const [s, setS] = useState<Summary | null>(null);
  const [mode, setMode] = useState<null | "use" | "min">(null);

  const load = useCallback(async () => {
    const r = await callOp(client, "get_ammo_summary", {});
    if ("error" in r) setS(null);
    else setS(r.result);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load, version]);

  if (!s || s.calibers.length === 0) return null;

  async function undo(id: string) {
    const r = await callOp(client, "log_ammo_use", { undoUseId: id });
    if ("error" in r) addToast({ title: "Couldn't undo", description: r.error, color: "danger" });
    else {
      addToast({ title: `Put back ${r.result.rounds} rounds of ${r.result.caliber}` });
      await load();
      onChanged();
    }
  }

  return (
    <div className="mb-6 rounded-md border border-default-200 bg-default-50 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-medium uppercase tracking-wider text-default-400">Ammo on hand · only you see this</p>
        <div className="flex gap-1">
          <Button size="sm" variant="flat" onPress={() => setMode("min")}>
            Minimums
          </Button>
          <Button size="sm" color="primary" variant="flat" onPress={() => setMode("use")}>
            Log use
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {s.calibers.map((c) => (
          <div key={c.caliber} className={`rounded-md px-3 py-1.5 border ${c.below ? "border-warning-300 bg-warning-50" : "border-default-200 bg-background"}`}>
            <p className="text-sm font-medium">{c.caliber}</p>
            <p className={`text-xs tabular-nums ${c.below ? "text-warning-700" : "text-default-500"}`}>
              {c.rounds.toLocaleString()} rds
              {c.minRounds != null && ` · min ${c.minRounds.toLocaleString()}`}
            </p>
          </div>
        ))}
      </div>
      {s.recentUses.length > 0 && (
        <div className="mt-3 text-xs text-default-500 space-y-0.5">
          {s.recentUses.slice(0, 3).map((u) => (
            <div key={u.id} className="flex items-center gap-2">
              <span className="tabular-nums">{u.date}</span>
              <span>
                {u.rounds} × {u.caliber}
                {u.note ? ` · ${u.note}` : ""}
              </span>
              <button type="button" className="text-primary" onClick={() => void undo(u.id)}>
                undo
              </button>
            </div>
          ))}
        </div>
      )}
      <AmmoModal
        mode={mode}
        calibers={s.calibers}
        client={client}
        onClose={() => setMode(null)}
        onDone={async () => {
          setMode(null);
          await load();
          onChanged();
        }}
      />
    </div>
  );
}

function AmmoModal({
  mode,
  calibers,
  client,
  onClose,
  onDone,
}: {
  mode: null | "use" | "min";
  calibers: Summary["calibers"];
  client: unknown;
  onClose: () => void;
  onDone: () => void;
}) {
  const [caliber, setCaliber] = useState("");
  const [rounds, setRounds] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    const first = calibers[0];
    setCaliber(first?.caliber ?? "");
    setRounds(mode === "min" && first?.minRounds != null ? String(first.minRounds) : "");
    setDate("");
    setNote("");
  }, [mode, calibers]);

  async function save() {
    const n = Number(rounds);
    if (!caliber || !Number.isInteger(n) || n < 0) {
      addToast({ title: "Pick a caliber and a whole number of rounds", color: "warning" });
      return;
    }
    setBusy(true);
    try {
      if (mode === "use") {
        const r = await callOp(client, "log_ammo_use", { caliber, rounds: n, ...(date ? { date } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
        if ("error" in r) throw new Error(r.error);
        addToast({
          title: `Logged ${r.result.rounds} rounds of ${r.result.caliber}`,
          description: `${r.result.remaining.toLocaleString()} left${r.result.shortfall ? ` · ${r.result.shortfall} more than you had on record` : ""}`,
          color: r.result.lowAmmo.length ? "warning" : "success",
        });
      } else {
        const r = await callOp(client, "save_ammo_threshold", { caliber, minRounds: n });
        if ("error" in r) throw new Error(r.error);
        addToast({ title: r.result.removed ? `No minimum for ${caliber}` : `Minimum for ${caliber}: ${n}`, color: "success" });
      }
      onDone();
    } catch (err) {
      addToast({ title: "Couldn't save", description: err instanceof Error ? err.message : String(err), color: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen={!!mode} onClose={onClose} size="md">
      <ModalContent>
        <ModalHeader>{mode === "use" ? "Log ammo use" : "Minimum rounds"}</ModalHeader>
        <ModalBody className="gap-3">
          <Select
            label="Caliber"
            selectedKeys={caliber ? [caliber] : []}
            onChange={(e) => {
              setCaliber(e.target.value);
              const c = calibers.find((x) => x.caliber === e.target.value);
              if (mode === "min") setRounds(c?.minRounds != null ? String(c.minRounds) : "");
            }}
          >
            {calibers.map((c) => (
              <SelectItem key={c.caliber}>{`${c.caliber} · ${c.rounds.toLocaleString()} rds`}</SelectItem>
            ))}
          </Select>
          <Input
            label={mode === "use" ? "Rounds used" : "Keep at least"}
            type="number"
            min={0}
            value={rounds}
            onValueChange={setRounds}
            description={mode === "use" ? "Taken from the oldest purchases first" : "0 removes the minimum; below it you get a WhatsApp message"}
            autoFocus
          />
          {mode === "use" && (
            <>
              <DateInput label="Date" value={date} onChange={setDate} />
              <Input label="Note" placeholder="Range day" value={note} onValueChange={setNote} />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
          <Button color="primary" onPress={save} isLoading={busy}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
