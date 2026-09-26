"use client";

// Create / edit modal for a shopping list (name + emoji). Used by the
// Shopping page and the home dashboard.

import React, { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/modal";

import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type ShoppingList = Schema["homeShoppingList"]["type"];

interface ShoppingListModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  list: ShoppingList | null;
  // sortOrder for a newly created list (usually the current list count).
  nextSortOrder: number;
  onSaved: () => void;
}

export function ShoppingListModal({
  isOpen,
  onOpenChange,
  list,
  nextSortOrder,
  onSaved,
}: ShoppingListModalProps) {
  const [formListName, setFormListName] = useState("");
  const [formListEmoji, setFormListEmoji] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setFormListName(list?.name ?? "");
    setFormListEmoji(list?.emoji ?? "");
  }, [isOpen, list]);

  async function saveList(onClose: () => void) {
    if (!formListName.trim()) return;
    if (list) {
      await client.models.homeShoppingList.update({
        id: list.id,
        name: formListName,
        emoji: formListEmoji || null,
      });
    } else {
      await client.models.homeShoppingList.create({
        name: formListName,
        emoji: formListEmoji || null,
        sortOrder: nextSortOrder,
      });
    }
    onClose();
    onSaved();
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{list ? "Edit List" : "New List"}</ModalHeader>
            <ModalBody>
              <Input
                label="Name"
                value={formListName}
                onValueChange={setFormListName}
                isRequired
                autoFocus={!list}
                placeholder="Supermarket, Home Depot, …"
              />
              <Input
                label="Emoji (optional)"
                value={formListEmoji}
                onValueChange={setFormListEmoji}
                placeholder="🛒"
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>Cancel</Button>
              <Button color="primary" onPress={() => saveList(onClose)}>
                {list ? "Save" : "Create"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
