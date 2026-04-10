"use client";

import React from "react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { Button } from "@heroui/button";
import { Link } from "@heroui/link";
import { FaTrash, FaDownload } from "react-icons/fa";
import dayjs from "dayjs";
import { photoUrl, originalPhotoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

type Photo = Schema["homePhoto"]["type"];

interface PhotoModalProps {
  photo: Photo | null;
  isOpen: boolean;
  onClose: () => void;
  onDelete?: () => void;
}

export function PhotoModal({ photo, isOpen, onClose, onDelete }: PhotoModalProps) {
  if (!photo) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex justify-between items-center gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{photo.originalFilename}</p>
            {photo.takenAt && (
              <p className="text-xs text-default-400">
                {dayjs(photo.takenAt).format("MMM D, YYYY h:mm A")}
              </p>
            )}
          </div>
        </ModalHeader>
        <ModalBody className="flex items-center justify-center p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl(photo.s3key, 1600, 85)}
            alt={photo.originalFilename ?? photo.id}
            className="max-w-full max-h-[80vh] object-contain"
          />
        </ModalBody>
        <ModalFooter>
          {onDelete && (
            <Button
              color="danger"
              variant="light"
              startContent={<FaTrash size={12} />}
              onPress={() => {
                if (confirm("Delete this photo?")) onDelete();
              }}
            >
              Delete
            </Button>
          )}
          <Button
            as={Link}
            href={originalPhotoUrl(photo.s3key)}
            target="_blank"
            variant="flat"
            startContent={<FaDownload size={12} />}
          >
            Download original
          </Button>
          <Button onPress={onClose}>Close</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
