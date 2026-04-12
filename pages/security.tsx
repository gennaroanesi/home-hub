"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useRouter } from "next/router";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { addToast, Spinner } from "@heroui/react";
import { FaArrowLeft, FaLink, FaUnlink, FaShieldAlt } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";
import { listAllPages } from "@/lib/list-all";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });

type Person = Schema["homePerson"]["type"];
type PersonAuth = Schema["homePersonAuth"]["type"];

export default function SecurityPage() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [auths, setAuths] = useState<PersonAuth[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftUsernames, setDraftUsernames] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await getCurrentUser();
        await loadAll();
      } catch {
        router.push("/login");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [allPeople, allAuths] = await Promise.all([
        listAllPages<Person>(client.models.homePerson, { limit: 100 }),
        listAllPages<PersonAuth>(client.models.homePersonAuth, { limit: 100 }),
      ]);
      setPeople(
        allPeople.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name))
      );
      setAuths(allAuths);
    } catch (err) {
      console.error("loadAll failed", err);
      addToast({ title: "Could not load security data", color: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);

  const authByPersonId = useMemo(() => {
    const map = new Map<string, PersonAuth>();
    for (const a of auths) {
      if (a.personId) map.set(a.personId, a);
    }
    return map;
  }, [auths]);

  async function linkPerson(person: Person) {
    const username = (draftUsernames[person.id] ?? "").trim();
    if (!username) {
      addToast({ title: "Enter a Duo username first", color: "warning" });
      return;
    }
    setSavingId(person.id);
    try {
      const { errors } = await client.models.homePersonAuth.create({
        personId: person.id,
        duoUsername: username,
        enrolledAt: new Date().toISOString(),
      });
      if (errors?.length) throw new Error(errors[0].message);
      addToast({ title: `Linked ${person.name}`, color: "success" });
      setDraftUsernames((prev) => ({ ...prev, [person.id]: "" }));
      await loadAll();
    } catch (err: any) {
      console.error(err);
      addToast({
        title: "Link failed",
        description: err?.message ?? "Unknown error",
        color: "danger",
      });
    } finally {
      setSavingId(null);
    }
  }

  async function unlinkPerson(person: Person, auth: PersonAuth) {
    if (!confirm(`Unlink Duo for ${person.name}?`)) return;
    setSavingId(person.id);
    try {
      const { errors } = await client.models.homePersonAuth.delete({ id: auth.id });
      if (errors?.length) throw new Error(errors[0].message);
      addToast({ title: `Unlinked ${person.name}`, color: "success" });
      await loadAll();
    } catch (err: any) {
      console.error(err);
      addToast({
        title: "Unlink failed",
        description: err?.message ?? "Unknown error",
        color: "danger",
      });
    } finally {
      setSavingId(null);
    }
  }

  function formatEnrolledAt(iso: string | null | undefined): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString();
    } catch {
      return iso;
    }
  }

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <Button size="sm" isIconOnly variant="light" onPress={() => router.push("/")}>
            <FaArrowLeft />
          </Button>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground flex items-center gap-2">
              <FaShieldAlt className="text-default-500" />
              Security
            </h1>
            <p className="text-xs text-default-500">Document vault access setup</p>
          </div>
        </div>

        {/* Info callout */}
        <Card className="mb-4 bg-primary-50 border border-primary-200">
          <CardBody className="text-sm space-y-2">
            <p>
              To access sensitive documents via Janet on WhatsApp, each household
              member needs to link their Duo Mobile account. You&apos;ll get a Duo Push
              notification when Janet needs to release a document; tap <strong>Approve</strong>{" "}
              on your phone to unlock it.
            </p>
            <div>
              <strong>Setup steps:</strong>
              <ol className="list-decimal ml-5 mt-1 space-y-0.5">
                <li>
                  Sign up at{" "}
                  <a
                    href="https://duo.com"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-primary-600"
                  >
                    duo.com
                  </a>{" "}
                  (Free plan, 10 users) if you haven&apos;t already
                </li>
                <li>In the Duo admin panel, create a user for each household member</li>
                <li>
                  Each person installs Duo Mobile and enrolls their phone via the QR
                  code emailed to them
                </li>
                <li>Back here, paste the Duo username for each person and click Link</li>
              </ol>
            </div>
          </CardBody>
        </Card>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner label="Loading security data…" />
          </div>
        ) : people.length === 0 ? (
          <Card>
            <CardBody className="text-center py-10 text-default-500">
              No active people. Add household members via Manage people first.
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-2">
            {people.map((person) => {
              const auth = authByPersonId.get(person.id) ?? null;
              const busy = savingId === person.id;
              return (
                <Card key={person.id}>
                  <CardHeader className="pb-0 pt-3 px-4">
                    <div className="flex items-center gap-2 font-medium">
                      <span className="text-xl">{person.emoji ?? "👤"}</span>
                      <span>{person.name}</span>
                    </div>
                  </CardHeader>
                  <CardBody className="pt-2 px-4 pb-3">
                    {auth ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm">
                          <div>
                            <span className="text-default-500">Linked: </span>
                            <span className="font-mono">{auth.duoUsername}</span>
                          </div>
                          {auth.enrolledAt && (
                            <div className="text-xs text-default-400">
                              Enrolled: {formatEnrolledAt(auth.enrolledAt)}
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          color="danger"
                          variant="flat"
                          startContent={<FaUnlink size={10} />}
                          isLoading={busy}
                          onPress={() => unlinkPerson(person, auth)}
                        >
                          Unlink
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-xs text-default-500 w-full sm:w-auto">
                          Not linked
                        </div>
                        <Input
                          size="sm"
                          placeholder="Duo username"
                          value={draftUsernames[person.id] ?? ""}
                          onValueChange={(v) =>
                            setDraftUsernames((prev) => ({ ...prev, [person.id]: v }))
                          }
                          className="flex-1 min-w-[180px]"
                        />
                        <Button
                          size="sm"
                          color="primary"
                          startContent={<FaLink size={10} />}
                          isLoading={busy}
                          onPress={() => linkPerson(person)}
                        >
                          Link
                        </Button>
                      </div>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DefaultLayout>
  );
}
