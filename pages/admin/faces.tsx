"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Card, CardBody } from "@heroui/card";
import { Select, SelectItem } from "@heroui/select";
import { FaArrowLeft } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { photoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type PhotoFace = Schema["homePhotoFace"]["type"];
type Photo = Schema["homePhoto"]["type"];

type BBox = { Width: number; Height: number; Left: number; Top: number };

export default function FacesPage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [unmatched, setUnmatched] = useState<PhotoFace[]>([]);
  const [photos, setPhotos] = useState<Record<string, Photo>>({});
  const [pendingAssign, setPendingAssign] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      await getCurrentUser();
      await loadAll();
    } catch {
      router.push("/login");
    }
  }

  const loadAll = useCallback(async () => {
    setLoading(true);

    // People for the dropdown
    const peopleRes = await client.models.homePerson.list();
    const sortedPeople = (peopleRes.data ?? []).sort((a, b) => a.name.localeCompare(b.name));
    setPeople(sortedPeople);

    // Unmatched faces. Filter server-side via attributeExists. Pagination
    // loop in case there are >100 — Amplify caps each page at 100.
    const collected: PhotoFace[] = [];
    let nextToken: string | null | undefined = undefined;
    do {
      const res: any = await client.models.homePhotoFace.list({
        filter: { personId: { attributeExists: false } },
        limit: 200,
        nextToken,
      });
      collected.push(...(res.data ?? []));
      nextToken = res.nextToken;
    } while (nextToken);

    // Sort newest first
    collected.sort((a, b) => {
      const ad = new Date(a.createdAt ?? 0).getTime();
      const bd = new Date(b.createdAt ?? 0).getTime();
      return bd - ad;
    });
    setUnmatched(collected);

    // Bulk-fetch the photos referenced by these faces (deduped). Sequential
    // because the data client doesn't expose batch get; in practice the set
    // is small (one row per unique unknown face).
    const uniquePhotoIds = Array.from(new Set(collected.map((f) => f.photoId)));
    const photoMap: Record<string, Photo> = {};
    await Promise.all(
      uniquePhotoIds.map(async (id) => {
        const r = await client.models.homePhoto.get({ id });
        if (r.data) photoMap[id] = r.data;
      })
    );
    setPhotos(photoMap);

    setLoading(false);
  }, []);

  async function assignFace(face: PhotoFace) {
    const personId = pendingAssign[face.id];
    if (!personId) return;
    if (!face.rekognitionFaceId) {
      alert("This face has no Rekognition id — cannot enroll.");
      return;
    }
    setBusy((b) => ({ ...b, [face.id]: true }));
    try {
      // 1. Create a homePersonFace row linking the face id to this person.
      //    Future photos containing this person will match via SearchFaces.
      await client.models.homePersonFace.create({
        personId,
        rekognitionFaceId: face.rekognitionFaceId,
        enrolledFromPhotoId: face.photoId,
        confidence: face.similarity ?? null,
      });
      // 2. Mark this specific homePhotoFace row as belonging to that person.
      await client.models.homePhotoFace.update({
        id: face.id,
        personId,
      });
      // Drop the row from the local list
      setUnmatched((rows) => rows.filter((r) => r.id !== face.id));
      setPendingAssign((m) => {
        const next = { ...m };
        delete next[face.id];
        return next;
      });
    } catch (err) {
      console.error("Failed to assign face:", err);
      alert("Failed to assign face. See console.");
    } finally {
      setBusy((b) => ({ ...b, [face.id]: false }));
    }
  }

  async function dismissFace(face: PhotoFace) {
    if (!confirm("Dismiss this face? It won't appear here again, but it can still be re-detected on future photos.")) return;
    setBusy((b) => ({ ...b, [face.id]: true }));
    try {
      await client.models.homePhotoFace.delete({ id: face.id });
      setUnmatched((rows) => rows.filter((r) => r.id !== face.id));
    } catch (err) {
      console.error("Failed to dismiss:", err);
    } finally {
      setBusy((b) => ({ ...b, [face.id]: false }));
    }
  }

  const groupedByPhoto = useMemo(() => {
    const groups = new Map<string, PhotoFace[]>();
    for (const f of unmatched) {
      if (!groups.has(f.photoId)) groups.set(f.photoId, []);
      groups.get(f.photoId)!.push(f);
    }
    return Array.from(groups.entries());
  }, [unmatched]);

  return (
    <DefaultLayout>
      <div className="max-w-4xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
              <FaArrowLeft />
            </Button>
            <h1 className="text-2xl font-bold text-foreground">Faces</h1>
          </div>
          <Button size="sm" variant="flat" onPress={loadAll} isLoading={loading}>
            Refresh
          </Button>
        </div>

        {loading && (
          <p className="text-center text-default-300 py-10">Loading…</p>
        )}

        {!loading && unmatched.length === 0 && (
          <p className="text-center text-default-300 py-10">
            No unmatched faces. New faces will appear here as photos are uploaded.
          </p>
        )}

        {!loading && people.length === 0 && unmatched.length > 0 && (
          <Card className="mb-4">
            <CardBody>
              <p className="text-sm text-warning">
                Add at least one person on{" "}
                <a className="underline" href="/admin/people">
                  /admin/people
                </a>{" "}
                before you can assign faces.
              </p>
            </CardBody>
          </Card>
        )}

        <div className="space-y-3">
          {groupedByPhoto.map(([photoId, faces]) => {
            const photo = photos[photoId];
            if (!photo) return null;
            return (
              <Card key={photoId}>
                <CardBody className="flex flex-col gap-4">
                  <div className="flex flex-wrap gap-4">
                    {faces.map((face) => {
                      const box = (face.boundingBox ?? null) as BBox | null;
                      return (
                        <div
                          key={face.id}
                          className="flex flex-col gap-2 items-stretch"
                          style={{ width: 160 }}
                        >
                          {box ? (
                            <FaceCrop photo={photo} box={box} size={160} />
                          ) : (
                            <div className="w-40 h-40 rounded bg-default-100 flex items-center justify-center text-xs text-default-400">
                              no bbox
                            </div>
                          )}
                          <Select
                            size="sm"
                            placeholder="Assign to…"
                            selectedKeys={
                              pendingAssign[face.id] ? [pendingAssign[face.id]] : []
                            }
                            onSelectionChange={(keys) => {
                              const id = Array.from(keys)[0] as string | undefined;
                              setPendingAssign((m) => ({ ...m, [face.id]: id ?? "" }));
                            }}
                          >
                            {people.map((p) => (
                              <SelectItem key={p.id}>{p.name}</SelectItem>
                            ))}
                          </Select>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              color="primary"
                              className="flex-1"
                              isDisabled={!pendingAssign[face.id] || !!busy[face.id]}
                              isLoading={!!busy[face.id]}
                              onPress={() => assignFace(face)}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="light"
                              isDisabled={!!busy[face.id]}
                              onPress={() => dismissFace(face)}
                            >
                              Dismiss
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-default-400 truncate">
                    {photo.originalFilename ?? photo.id}
                  </p>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </div>
    </DefaultLayout>
  );
}

/**
 * Renders a square crop of `photo` showing just the face inside `box`.
 * Uses the photo's stored width/height to compute the right scale + offset.
 * Falls back to a 4:3 aspect ratio if the photo's dimensions are missing.
 */
function FaceCrop({ photo, box, size }: { photo: Photo; box: BBox; size: number }) {
  const aspect = photo.width && photo.height ? photo.width / photo.height : 4 / 3;

  // Render width is chosen so the face's bbox occupies `size` pixels wide.
  // Add a tiny zoom-out factor (0.85) so the face isn't right at the edge.
  const padding = 0.85;
  const imgWidth = (size / box.Width) * padding;
  const imgHeight = imgWidth / aspect;

  const faceCenterX = (box.Left + box.Width / 2) * imgWidth;
  const faceCenterY = (box.Top + box.Height / 2) * imgHeight;
  const left = size / 2 - faceCenterX;
  const top = size / 2 - faceCenterY;

  // Request an image at least as large as we'll render it
  const requestedWidth = Math.min(2000, Math.max(800, Math.ceil(imgWidth)));

  return (
    <div
      style={{
        width: size,
        height: size,
        position: "relative",
        overflow: "hidden",
        borderRadius: 8,
        background: "#222",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(photo.s3key, requestedWidth)}
        alt=""
        style={{
          position: "absolute",
          width: imgWidth,
          height: imgHeight,
          left,
          top,
          maxWidth: "none",
        }}
      />
    </div>
  );
}
