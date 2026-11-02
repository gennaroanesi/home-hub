# Operations layer (`lib/ops/`)

Status: pilot, 2026-10-31. Wardrobe, notes and inventory categories are on it; everything else
still runs through the legacy tool code in `amplify/functions/agent/handler.ts`.

## Why

The same action used to be written several times: the web page wrote to
DynamoDB itself (validation and defaults in React), Janet had her own copy
as a tool, the Muse API borrowed Janet's copy, and custom AppSync mutations
were wired one by one. An operation is now written once and every surface
is generated from it.

## Shape

```
lib/ops/
  define.ts      defineOp({ name, domain, description, access, input, output, run })
  context.ts     OpContext: data client, image storage, who is acting (person + via)
  registry.ts    OPS, findOp, runOp (validate → access check → run), toolDefinition, opJsonSchemas
  people.ts      resolvePerson (personId | personName | the actor)
  storage.ts     S3 image storage used by the Lambdas
  <domain>.ts    one file per domain (wardrobe.ts, later inventory.ts, tasks.ts …);
                 a domain that grows too big becomes a folder with an index.ts
lib/ops-client.ts  typed callOp(client, name, input) for web + mobile

amplify/functions/ops/     runs any op; exposed as the runOp(name, input) AppSync mutation
amplify/functions/agent/   Janet: tools = legacy tools + registry; runs ops in-process
pages/api/v1/              external API: OpenAPI from the tool list (ops carry typed output + x-access)
scripts/hh.ts              generic CLI over the external API (dry run unless --yes for writes)
.claude/skills/home-hub-cli/  how to use hh
```

| Surface | Reaches an op through |
|---|---|
| Web / mobile | `callOp(client, "save_wardrobe_item", …)` → `runOp` mutation (Cognito, `home-users`) |
| Janet (WhatsApp) | her tool list, built from the registry; executed in her Lambda |
| External API (Muse, other clients) | `POST /api/v1/tools/<name>`, spec generated from the registry; `/api/muse/*` still works as a rewrite |
| CLI | `hh <name> --field value`, generated from the spec |

## Rules

- **One zod schema per op input and output.** Input validates every caller
  and becomes Claude's tool schema and the OpenAPI request body
  (`z.toJSONSchema`). Output types the client and the OpenAPI response.
- **Op names are snake_case verbs** (`save_wardrobe_item`) so they double as
  tool names and API paths.
- **Access:** `read`, `write` or `sensitive`. Sensitive ops are never exposed
  on the API or CLI; the CLI dry-runs anything that isn't `read` unless `--yes`.
- **Plain reads stay on GraphQL.** Pages keep listing models directly (fast,
  live). Ops are for writes with rules and for computed reads (suggestions,
  trip plans).
- **Long ops** (Claude calls) keep the async pattern: write a GENERATING row,
  return its id, let the client poll. AppSync times out at 30s.
- **Person:** ops take `personId` or `personName`; if neither, the actor
  (Janet's sender, the API key's `MUSE_SENDER`). The web always passes `personId`.

## Firewall on the external API

The Amplify-created WAF sits in front of `/api/v1/*` (the web, mobile and
Janet paths go through AppSync and don't pass it). A block shows up as a
CloudFront 403 before the app sees the request, so a bad key returning 401
means the request got through.

- **Size:** `SizeRestrictions_BODY` blocked bodies from 8,192 bytes, which
  stopped whole-note saves. It's been on Count since 2026-11-01, for the whole
  site. This lives in AWS, not in the repo: if the ACL is ever recreated, run
  `AWS_PROFILE=admin node scripts/waf-allow-large-bodies.mjs --apply`.
- **Content:** other rules are still on, so text containing `../` gets a 403,
  even in a small note.

## Tests

- **Unit** (`npm test`): each domain's ops against a fake data client
  (`lib/ops/<domain>.test.ts`), image storage against a fake S3
  (`storage.test.ts`), `callOp`, the OpenAPI generator (`lib/external-api.test.ts`)
  and the CLI's flag parsing (`scripts/hh.test.ts`).
- **Integration, after each deploy** (`npm run ops-smoke -- <outputs.json>`):
  hits the deployed runOp mutation, the agent Lambda's API entry points and
  the external API with reads and deliberately invalid writes only. See the
  script header for setup.

## Migrating a domain

1. Write `lib/ops/<domain>.ts` with the ops and their tests; add them to `OPS`.
2. Delete the matching legacy tool definitions and `case`s from the agent
   handler (registry names win, so Janet and Muse keep the same names).
3. Point the web/mobile writes at `callOp`.
4. Fold the domain's custom mutations into ops when they're next touched
   (wardrobe: `suggestOutfit`, `planTripOutfits` are still separate).
