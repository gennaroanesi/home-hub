// Pieces shared by the Household (/admin/people) and Contacts (/contacts)
// pages.

import React, { useState } from "react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Card, CardBody } from "@heroui/card";
import { Chip } from "@heroui/chip";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";
import { addToast } from "@heroui/react";
import { FaTimes } from "react-icons/fa";

import { callOp } from "@/lib/ops-client";
import { PeoplePicker } from "@/components/people-picker";
import { photoUrl } from "@/lib/image-loader";
import {
  RELATION_KINDS,
  RELATION_LABELS,
  type RelationKind,
  type RelationshipRow,
  relationsOf,
} from "@/lib/relationships";
import type { Schema } from "@/amplify/data/resource";

export type Person = Schema["homePerson"]["type"];

export function PersonAvatar({
  person,
  size = 32,
}: {
  person: Pick<Person, "name" | "color" | "emoji"> & { photoKey?: string | null };
  size?: number;
}) {
  if (person.photoKey) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={photoUrl(person.photoKey, size * 3)} alt={person.name} className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-white text-sm font-medium shrink-0"
      style={{
        backgroundColor: person.color ?? "#3a5068",
        width: size,
        height: size,
      }}
    >
      {person.emoji || person.name[0]}
    </div>
  );
}

/**
 * Pick the row to merge `source` into. mergePeople rewrites every
 * reference to the source (tasks, events, faces, documents, …) and
 * deletes it; useful when a face-tag row and a login row are the same
 * person.
 */
export function MergeModal({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client,
  source,
  people,
  isOpen,
  onOpenChange,
  onMerged,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  source: Person | null;
  people: Person[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}) {
  async function merge(target: Person, onClose: () => void) {
    if (!source) return;
    if (
      !confirm(
        `Merge ${source.name} into ${target.name}? Every reference to ${source.name} will be rewritten and the row deleted.`,
      )
    )
      return;
    try {
      const res = await client.mutations.mergePeople({
        sourceId: source.id,
        targetId: target.id,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      addToast({
        title: "Merged",
        description: JSON.stringify(res.data?.rewrites ?? {}),
      });
      onClose();
      onMerged();
    } catch (err) {
      addToast({
        title: "Merge failed",
        description: err instanceof Error ? err.message : String(err),
        color: "danger",
      });
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Merge {source?.name} into…</ModalHeader>
            <ModalBody>
              <p className="text-xs text-default-500 mb-2">
                Every reference to {source?.name} (tasks, events, faces,
                documents, reminders, etc.) will be rewritten to point at the
                target row, then this row will be deleted.
              </p>
              <div className="space-y-2">
                {people
                  .filter((p) => p.id !== source?.id)
                  .map((p) => (
                    <Card
                      key={p.id}
                      isPressable
                      onPress={() => merge(p, onClose)}
                      className="w-full"
                    >
                      <CardBody className="flex flex-row items-center gap-3 px-4 py-3">
                        <PersonAvatar person={p} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{p.name}</p>
                          <div className="flex gap-1 flex-wrap">
                            {(p.groups ?? []).filter(Boolean).map((g) => (
                              <Chip key={g} size="sm" variant="flat">
                                {g}
                              </Chip>
                            ))}
                          </div>
                        </div>
                      </CardBody>
                    </Card>
                  ))}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                Cancel
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

/** "Gabrielle (spouse) · Eva (daughter)" for a card. */
export function relationsLine(
  personId: string,
  rels: RelationshipRow[],
  byId: Map<string, Pick<Person, "name">>,
): string {
  return relationsOf(personId, rels)
    .filter((r) => byId.has(r.otherPersonId))
    .map((r) => `${byId.get(r.otherPersonId)!.name} (${r.role})`)
    .join(" · ");
}

/**
 * The relationships section of a person's edit dialog: who's related to
 * them and how, plus a row to add one ("Eva is Priscilla's child,
 * daughter"). Saves immediately through save_relationship, the op Janet
 * uses; one link per pair, so linking an already-linked pair replaces it.
 */
export function RelationshipsEditor({
  client,
  person,
  people,
  rels,
  onChanged,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  person: Person;
  people: Person[];
  rels: RelationshipRow[];
  onChanged: () => void;
}) {
  const [otherId, setOtherId] = useState("");
  const [kind, setKind] = useState<RelationKind | "">("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const byId = new Map(people.map((p) => [p.id, p]));
  const current = relationsOf(person.id, rels).filter((r) =>
    byId.has(r.otherPersonId),
  );

  async function run(input: Parameters<typeof callOp<"save_relationship">>[2]) {
    setBusy(true);
    const r = await callOp(client, "save_relationship", input);
    setBusy(false);
    if ("error" in r) {
      addToast({
        title: "Couldn't save",
        description: r.error,
        color: "danger",
      });
      return false;
    }
    onChanged();
    return true;
  }

  async function add() {
    if (!otherId || !kind) return;
    // "<other> is <person>'s <kind>", with the word for the other side.
    const ok = await run({
      personId: otherId,
      kind,
      relatedPersonId: person.id,
      label: word.trim() || null,
    });
    if (ok) {
      setOtherId("");
      setKind("");
      setWord("");
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-2 border-t border-default-100">
      <p className="text-xs font-medium text-default-500 uppercase tracking-wide">
        Relationships
      </p>
      {current.length === 0 && (
        <p className="text-xs text-default-400">None yet.</p>
      )}
      {current.map((r) => (
        <div key={r.relationshipId} className="flex items-center gap-2">
          <span className="text-sm flex-1">
            {byId.get(r.otherPersonId)!.name}{" "}
            <span className="text-default-400">
              is {person.name}&apos;s {r.role}
            </span>
          </span>
          <Button
            size="sm"
            isIconOnly
            variant="light"
            title="Unlink"
            isDisabled={busy}
            onPress={() =>
              run({
                personId: person.id,
                relatedPersonId: r.otherPersonId,
                remove: true,
              })
            }
          >
            <FaTimes size={10} />
          </Button>
        </div>
      ))}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
        <PeoplePicker
          single
          size="sm"
          label="Who"
          people={people.filter((p) => p.id !== person.id)}
          selectedIds={otherId ? [otherId] : []}
          onChange={(ids) => setOtherId(ids[0] ?? "")}
        />
        <Select
          size="sm"
          label={`is ${person.name}'s`}
          selectedKeys={kind ? new Set([kind]) : new Set<string>()}
          onSelectionChange={(k) =>
            setKind(
              String(Array.from(k as Set<string>)[0] ?? "") as
                RelationKind | "",
            )
          }
        >
          {RELATION_KINDS.map((k) => (
            <SelectItem key={k}>{RELATION_LABELS[k]}</SelectItem>
          ))}
        </Select>
        <Input
          size="sm"
          label="Word (optional)"
          placeholder="daughter"
          value={word}
          onValueChange={setWord}
        />
      </div>
      <Button
        size="sm"
        variant="flat"
        className="self-end"
        isDisabled={!otherId || !kind}
        isLoading={busy}
        onPress={add}
      >
        Add relationship
      </Button>
    </div>
  );
}
