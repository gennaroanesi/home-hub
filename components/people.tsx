// Pieces shared by the Household (/admin/people) and Contacts (/contacts)
// pages.

import React from "react";
import { Button } from "@heroui/button";
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

import type { Schema } from "@/amplify/data/resource";

export type Person = Schema["homePerson"]["type"];

export function PersonAvatar({
  person,
  size = 32,
}: {
  person: Pick<Person, "name" | "color" | "emoji">;
  size?: number;
}) {
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
