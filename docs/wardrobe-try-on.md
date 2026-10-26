# Wardrobe virtual try-on

The existing `suggestOutfit` mutation selects three outfits using stored garment
metadata, style notes, weather, calendar and wear history. It does not send
wardrobe images to the stylist. The main brief accepts mood, occasion, partner
outfit and requested pieces. Separate wearing instructions (tucked/open/etc.)
also go to the renderer.

## User flow

1. In Wardrobe > Closet settings, upload up to three JPEG, PNG or WebP reference
   photos (10 MB each). The first is the primary body/pose reference. Additional
   photos supplement identity. Set fit preferences if desired.
2. In Suggest an outfit, write the brief and optional wearing instructions.
3. Preview individual suggestions, or select automatic previews before suggesting.
4. Save a chosen preview as a look. Its image, item IDs, styling explanation,
   wearing instructions and original brief are retained. Changing a saved look's
   pieces clears its old preview on save.
5. Recent try-ons persist independently of the browser. After returning, pending
   jobs resume polling and completed images can be saved as looks.

## Configuration and deployment

Set `OPENAI_API_KEY` in the backend deployment environment (locally `.env.local`).
It is passed only to the rendering Lambda, never to the browser. Existing
`HOME_HUB_BUCKET` and `ANTHROPIC_API_KEY` configuration remains required.
Optional `WARDROBE_TRY_ON_MODEL` overrides the default `gpt-image-2.5-sunburst`.
The default render is one high-quality 1024x1536 PNG per distinct outfit.

Deploy the Amplify backend and frontend together through the existing deployment
workflow. This adds `homeWardrobeTryOn`, profile reference fields, look preview
fields and `requestWardrobeTryOn`. The new Lambda gets scoped S3 access under
`home/wardrobe/`, access to its job table, and permission to invoke itself.
No new package dependency is needed.

The OpenAI account must have access to the configured image model. Implementation
uses the documented [Image Edits API](https://developers.openai.com/api/reference/resources/images/methods/edit)
with multiple reference images. Model quality on the household's real photos
still needs visual evaluation; generated previews are not measurements of fit.

## Cache and job semantics

The cache key hashes renderer/prompt version, model, output quality/size, person,
ordered reference photo keys, sorted garment IDs/photo keys/descriptions, fit
notes and wearing instructions. A changed occasion alone can reuse an image.
Upload keys are immutable UUIDs: replacing a reference/garment photo must create
a new key, as the existing uploader does. Do not overwrite image objects in place.

The mutation validates person/garment ownership, wearable status and supported
photos before scheduling. A conditional DynamoDB write elects one request to
queue a cache miss; a second conditional claim prevents duplicate Lambda events
from generating duplicate images. Attempt tokens stop late workers from
replacing a newer retry. READY entries never regenerate automatically. FAILED
entries and jobs idle for ten minutes can be retried explicitly. Each worker
has a five-minute timeout, and its provider call has a four-minute timeout.

Job writes are backend-only; household members can read them through Amplify.
The worker uses direct table writes, so the UI polls rather than depending on
AppSync subscriptions. History stops polling when no current jobs are pending.
Images use the same bucket and CloudFront delivery as existing wardrobe photos.
Uploaded references therefore inherit that existing household storage/access
model; no separate private photo store was introduced.

Reusing completed images avoids another model call. New outfits still require
reading reference and garment images and generating a new image; this does not
claim provider-side input-token caching or fine-tuning. Garment visual analysis
and reference resizing are not added: suggestions already consume the garment
metadata, and rendering uses the stored originals with size limits.

## Validation

- `node node_modules/vitest/vitest.mjs run lib/wardrobe.test.ts lib/wardrobe-try-on.test.ts`
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`
- `node node_modules/typescript/bin/tsc -p amplify/tsconfig.json --noEmit`

Before production use, exercise a reference upload, three alternatives, an exact
cache hit, a provider failure/retry, leaving and returning during generation,
and saving/editing a look against a deployed backend. API calls and AWS job
concurrency have not been exercised by the local mocked provider tests.
