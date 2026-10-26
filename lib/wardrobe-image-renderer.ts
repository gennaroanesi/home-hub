import { renderPrompt, type RenderInputs } from "./wardrobe-try-on";

export interface RenderImage { bytes: Uint8Array; contentType: string }
/** Direct Image Edits API; no extra text-model call or conversational history. */
export async function renderWardrobeImage(
  input: RenderInputs,
  images: RenderImage[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const form = new FormData();
  form.set("model", input.model);
  form.set("prompt", renderPrompt(input));
  form.set("n", "1");
  form.set("quality", "high");
  form.set("size", "1024x1536");
  form.set("output_format", "png");
  images.forEach((image, i) => {
    const ext = image.contentType === "image/png" ? "png" : image.contentType === "image/webp" ? "webp" : "jpg";
    form.append("image[]", new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), `${i}.${ext}`);
  });
  const response = await fetchImpl("https://api.openai.com/v1/images/edits", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) {
    // Never persist raw provider errors, request payloads, or keys in a job.
    throw new Error(`Image generation failed (${response.status}). Check the renderer's API access or try again.`);
  }
  const result = await response.json() as { data?: { b64_json?: string }[] };
  const data = result.data?.[0]?.b64_json;
  if (!data) throw new Error("The renderer returned no image. Try a different reference photo or outfit.");
  return new Uint8Array(Buffer.from(data, "base64"));
}
