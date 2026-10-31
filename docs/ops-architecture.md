# Operations layer (`lib/ops/`)

Status: pilot, 2026-10-31. Wardrobe is the first domain; everything else
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
pages/api/muse/            OpenAPI from the tool list (ops carry typed output + x-access)
scripts/hh.ts              generic CLI over the Muse API (dry run unless --yes for writes)
.claude/skills/home-hub-cli/  how to use hh
```

| Surface | Reaches an op through |
|---|---|
| Web / mobile | `callOp(client, "save_wardrobe_item", …)` → `runOp` mutation (Cognito, `home-users`) |
| Janet (WhatsApp) | her tool list, built from the registry; executed in her Lambda |
| Muse | `POST /api/muse/tools/<name>`, spec generated from the registry |
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
  (Janet's sender, Muse's `MUSE_SENDER`). The web always passes `personId`.

## Migrating a domain

1. Write `lib/ops/<domain>.ts` with the ops and their tests; add them to `OPS`.
2. Delete the matching legacy tool definitions and `case`s from the agent
   handler (registry names win, so Janet and Muse keep the same names).
3. Point the web/mobile writes at `callOp`.
4. Fold the domain's custom mutations into ops when they're next touched
   (wardrobe: `suggestOutfit`, `planTripOutfits` are still separate).
