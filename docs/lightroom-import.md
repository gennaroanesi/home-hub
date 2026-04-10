# Lightroom import

Import photos from Adobe Lightroom (cloud) into home-hub albums via a
local script. Photos are downloaded at full resolution and uploaded to
S3, so home-hub doubles as a backup of your Lightroom catalog.

## How it works

The flow is intentionally simple — no production UI, no token storage in
DynamoDB, no callback server.

1. **Adobe app** — OAuth Web App credential in the Adobe Developer Console
   with the Lightroom Services API enabled.
2. **One-time auth** — `scripts/lightroom-auth.mjs` runs the OAuth dance,
   you copy the code from the home-hub callback page back into the terminal,
   and the script writes a refresh token to `.env.local`.
3. **Importer** — `scripts/lightroom-import.mjs` reads the refresh token,
   lists albums via the Lightroom API, downloads each photo's fullsize
   rendition, uploads it to S3, and creates `homePhoto` + `homeAlbumPhoto`
   records via signed AppSync calls.

The refresh token lasts about 14 days. When it expires, re-run
`scripts/lightroom-auth.mjs`.

## Setup (one-time)

### 1. Adobe Developer Console

In the [Adobe Developer Console](https://developer.adobe.com/console):

- Create a project (or open an existing one)
- Add the **Lightroom Services API**
- Add an **OAuth Web App** credential with:
  - **Default redirect URI**: `https://home.cristinegennaro.com/api/lightroom/callback`
  - **Redirect URI Pattern**: `https://home\.cristinegennaro\.com/api/lightroom/callback`
  - Scopes: `openid`, `AdobeID`, `lr_partner_apis`, `offline_access`

Copy the Client ID and Client Secret.

### 2. `.env.local`

Add the credentials and (initially blank) refresh token:

```ini
ADOBE_CLIENT_ID=...
ADOBE_CLIENT_SECRET=...
LIGHTROOM_REFRESH_TOKEN=
```

`.env.local` is gitignored.

### 3. AWS credentials

The importer signs AppSync requests with SigV4 (the schema uses
`AWS_IAM` auth mode). It needs AWS credentials from the standard chain
— easiest is to run with the `admin` profile:

```sh
export AWS_PROFILE=admin
```

## Get the refresh token

```sh
node scripts/lightroom-auth.mjs
```

What happens:

1. Script prints the Adobe consent URL and opens it in your default browser.
2. You sign in to Adobe and approve the requested scopes.
3. Adobe redirects you to `https://home.cristinegennaro.com/api/lightroom/callback?code=...`
4. The callback page displays the code in big text with a copy button.
5. Paste the code back into the terminal where the script is waiting.
6. The script exchanges the code for tokens and writes
   `LIGHTROOM_REFRESH_TOKEN=...` back to `.env.local`.

You only need to do this once every ~14 days. If the importer starts
failing with token errors, re-run this script.

## Import an album

### List your Lightroom albums

```sh
AWS_PROFILE=admin node scripts/lightroom-import.mjs --list-albums
```

Prints all "collection" albums (not the parent "collection set" containers).
Each row is `<id>  <name>`.

### Dry-run with a small limit

Always test first to confirm the right album was matched and metadata
looks reasonable:

```sh
AWS_PROFILE=admin node scripts/lightroom-import.mjs \
  --lr-album "Italy 2026" \
  --limit 3 \
  --dry-run
```

`--dry-run` skips the actual download / S3 upload / AppSync writes; it
just prints what would be imported.

### Run the real import

Drop `--dry-run` and `--limit` when you're happy:

```sh
AWS_PROFILE=admin node scripts/lightroom-import.mjs --lr-album "Italy 2026"
```

By default the home-hub album is created with the same name as the
Lightroom album. Override with `--home-album`:

```sh
AWS_PROFILE=admin node scripts/lightroom-import.mjs \
  --lr-album "Italy 2026 - Edited" \
  --home-album "Italy 2026"
```

If a home-hub album with that name already exists, photos are added to it.

### Target an existing home-hub album by ID

When you want to add photos to a specific existing album (and avoid any
name-matching ambiguity), look up the ID first and pass `--home-album-id`:

```sh
# 1. List your home-hub albums
AWS_PROFILE=admin node scripts/lightroom-import.mjs --list-home-albums

# 2. Import into a specific one (the script errors out if the ID doesn't exist —
#    no album is created)
AWS_PROFILE=admin node scripts/lightroom-import.mjs \
  --lr-album "Italy 2026 - Edited" \
  --home-album-id 0190f3ab-1234-7890-abcd-ef0123456789
```

`--home-album-id` takes precedence over `--home-album` if both are passed.

## Flags

| Flag                       | Description                                                                |
| -------------------------- | -------------------------------------------------------------------------- |
| `--list-albums`            | Print all Lightroom albums and exit                                        |
| `--list-home-albums`       | Print all home-hub albums (with IDs) and exit                              |
| `--lr-album <name>`        | Lightroom album name (fuzzy matched, case-insensitive)                     |
| `--lr-album-id <uuid>`     | Lightroom album ID (exact, from `--list-albums`)                           |
| `--home-album <name>`      | home-hub album name (find by name, create if missing)                      |
| `--home-album-id <uuid>`   | Existing home-hub album ID. Errors if it doesn't exist (no auto-create)    |
| `--limit <n>`              | Cap the number of photos to import (useful with `--dry-run`)               |
| `--dry-run`                | Don't download/upload/write — just print what would be imported            |
| `--prod`                   | Target production AppSync (default is sandbox via `amplify_outputs.json`)  |
| `--appsync-url <url>`      | Explicit AppSync endpoint override (advanced)                              |

## Sandbox vs production

By default the importer reads `amplify_outputs.json`, which points at
your local **sandbox** while `npx ampx sandbox` is running. That's the
safer default — you can test the full flow end-to-end without touching
production data.

When you want to import into the production app, pass `--prod`:

```sh
AWS_PROFILE=admin node scripts/lightroom-import.mjs --prod --lr-album "Italy 2026"
```

The script prints which environment it's targeting on the first line so
you always know:

```
Target: PROD — https://pzn6gqjwxndatgpb6ujcey47fe.appsync-api.us-east-1.amazonaws.com/graphql
```

vs

```
Target: sandbox (from amplify_outputs.json) — https://xvimf4w34ndoflazehzpozjnga...
```

## What gets imported

For each Lightroom asset:

- **Fullsize JPEG rendition** uploaded to
  `s3://cristinegennaro.com/home/photos/albums/{albumId}/{uuid}.jpg`
- A `homePhoto` row with:
  - `s3key`, `originalFilename`, `contentType: "image/jpeg"`, `sizeBytes`
  - `width`, `height` (from Lightroom develop dimensions)
  - `takenAt` (from XMP `DateTimeOriginal`)
  - `latitude`, `longitude` (from XMP GPS, decimal degrees)
  - `sourceProvider: "lightroom"`, `sourceAssetId: <Lightroom asset id>`
  - `uploadedBy: "lightroom-import"`
- A `homeAlbumPhoto` join row linking the photo to the home-hub album

## Dedup / re-running

The importer is idempotent. Before importing each asset it checks for
an existing `homePhoto` with the same `sourceAssetId` and skips it.
You can re-run the same import safely — only new photos will be
downloaded.

If you delete a photo from home-hub and then re-run the import, it will
be re-downloaded (the dedup check finds nothing).

## Limitations

- **Only cloud-synced photos**: Lightroom Classic photos won't appear
  in the API unless you've enabled cloud sync for them. Lightroom (cloud)
  photos work out of the box.
- **No video support**: video assets are skipped (the script logs
  "skip non-image (video)" and moves on).
- **Sequential downloads**: photos are downloaded one at a time. For
  hundreds of photos, expect minutes-to-tens-of-minutes. Live with it
  for now; we can parallelize if needed.
- **Auto-retry**: there's no built-in retry. If a single photo fails,
  the script logs `FAILED` and continues. Re-run the importer and the
  failed ones will be picked up (they have no `sourceAssetId` row).
- **Token expiry**: refresh tokens last ~14 days. Re-run
  `scripts/lightroom-auth.mjs` to get a new one when imports start
  failing with `Token refresh failed: 400`.

## Troubleshooting

### `Token refresh failed: 400`

Refresh token expired (or was revoked). Run:

```sh
node scripts/lightroom-auth.mjs
```

### `AppSync request failed: 401`

AWS credentials missing or wrong. Set `AWS_PROFILE`:

```sh
export AWS_PROFILE=admin
```

### `No Lightroom albums found`

The Adobe account you authenticated with has no synced Lightroom albums,
or the OAuth scope is wrong. Re-run `scripts/lightroom-auth.mjs` and
make sure you authenticated with the correct Adobe account.

### Photo dimensions are missing / wrong

Lightroom's API exposes width/height under
`payload.develop.croppedDimensions` (post-crop). If a photo wasn't
cropped, it falls back to `payload.develop.dimensions`. Either way the
CloudFront image loader can serve any size — dimensions are mainly used
for the masonry layout to reserve the right cell height.
