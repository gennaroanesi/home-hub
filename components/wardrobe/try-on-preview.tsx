import React, { useEffect, useRef, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { Button } from "@heroui/button";
import { photoUrl } from "@/lib/image-loader";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });
export type TryOnJob = Schema["homeWardrobeTryOn"]["type"];
export function TryOnPreview({ personId, itemIds, instructions, autoStart, initialJobId, onStarted, onReady, controlsOnly, idleLabel }: {
  personId: string; itemIds: string[]; instructions: string; autoStart?: boolean; initialJobId?: string;
  onStarted?: () => void;
  onReady: (job: TryOnJob) => void;
  /** Just the button + status; the parent shows the image (look editor). */
  controlsOnly?: boolean;
  idleLabel?: string;
}) {
  const [jobId, setJobId] = useState(initialJobId ?? "");
  const [job, setJob] = useState<TryOnJob | null>(null);
  const [busy, setBusy] = useState(!!initialJobId);
  const [error, setError] = useState("");
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const started = useRef(false);
  // regenerate: skip the render cache and make a new image for the same inputs.
  async function start(regenerate = false) {
    setBusy(true); setError(""); setJob(null); setJobId("");
    try {
      const { data, errors } = await client.mutations.requestWardrobeTryOn({ personId, itemIds, stylingInstructions: instructions, regenerate });
      if (errors?.length || data?.error || !data?.jobId) throw new Error(data?.error || errors?.[0]?.message || "Couldn't start preview.");
      setJobId(data.jobId);
      onStarted?.();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't start preview."); setBusy(false); }
  }
  useEffect(() => {
    if (autoStart && !started.current) { started.current = true; void start(); }
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { data, errors } = await client.models.homeWardrobeTryOn.get({ id: jobId });
        if (disposed) return;
        if (errors?.length) throw new Error(errors[0].message);
        if (!data) throw new Error("Preview not found. Please retry.");
        setJob(data);
        if (data.status === "READY" && data.previewImageKey) { setBusy(false); readyRef.current(data); return; }
        if (data.status === "FAILED") { setBusy(false); setError(data.error || "Preview failed. Please retry."); return; }
        if (Date.now() - new Date(data.updatedAt).getTime() > 10 * 60_000) {
          setBusy(false); setError("This preview timed out. Retry to start a new attempt."); return;
        }
        timer = setTimeout(poll, 4000);
      } catch (err) { if (!disposed) { setBusy(false); setError(err instanceof Error ? err.message : "Couldn't load preview."); } }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [jobId]);
  const ready = job?.status === "READY" && !!job.previewImageKey;
  const busyLabel = job?.status === "PROCESSING" ? "Rendering your outfit…" : "Preparing preview…";
  if (controlsOnly) {
    return <div className="flex flex-col gap-1">
      <Button size="sm" variant="flat" onPress={() => start(true)} isLoading={busy}>
        {busy ? busyLabel : error ? "Retry" : idleLabel ?? "Regenerate try-on"}
      </Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>;
  }
  return <div className="flex flex-col gap-2">
    {ready ? <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoUrl(job!.previewImageKey!, 800)} alt="AI-generated outfit preview" className="w-full max-h-[600px] object-contain rounded-lg bg-default-50" />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-default-500">AI-generated preview · fit and details may vary</p>
        <Button size="sm" variant="light" onPress={() => start(true)}>Regenerate</Button>
      </div>
    </> : <Button size="sm" variant="flat" onPress={() => start()} isLoading={busy}>
      {busy ? busyLabel : error ? "Retry preview" : "Preview on me"}
    </Button>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
