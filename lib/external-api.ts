/**
 * Shared plumbing for the external API gateway at /api/v1/*.
 *
 * External clients (assistants like Meta's Muse, the hh CLI, other third-party
 * services) can't do a Cognito login, so each gets its own static bearer key
 * and acts as one household member. The keys live in Secrets Manager
 * (`home-hub/api-clients`, lib/api-clients.ts; add / list / revoke with
 * scripts/api-clients.ts). Every request is forwarded to the home-agent
 * Lambda, which owns the tool definitions and executeTool — the gateway
 * never touches DynamoDB itself, so the tool surface and the OpenAPI spec
 * stay in lockstep with what the WhatsApp agent can do.
 *
 * Env vars (Amplify Hosting → forwarded to SSR via amplify.yml):
 *   API_CLIENTS_SECRET_NAME  — optional, defaults to home-hub/api-clients
 *   MUSE_API_KEY / MUSE_SENDER — legacy single key, still accepted (as client
 *                              "muse-env") until it's moved into the secret
 *   HOME_AGENT_FUNCTION_NAME — written by backend postBuild from stack outputs
 */

import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { API_CLIENTS_SECRET_NAME, hashApiKey, matchApiClient, parseApiClients, type ApiClient } from "./api-clients";

const lambda = new LambdaClient({ region: "us-east-1" });
const secrets = new SecretsManagerClient({ region: "us-east-1" });

export type ApiTool = {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  // Set for lib/ops operations; legacy agent tools have neither.
  output_schema?: Record<string, unknown>;
  access?: "read" | "write" | "sensitive";
};

export type ApiContext = { sender: string; client: string };

export type ApiHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  ctx: ApiContext
) => void | Promise<void>;

// The client list is re-read at most every CLIENTS_TTL_MS per SSR container,
// so a new or revoked key takes effect within that without a redeploy.
const CLIENTS_TTL_MS = 5 * 60_000;
let clientsCache: { at: number; clients: ApiClient[] } | null = null;

async function loadSecretClients(): Promise<ApiClient[]> {
  const now = Date.now();
  if (clientsCache && now - clientsCache.at < CLIENTS_TTL_MS) return clientsCache.clients;
  const secretId = process.env.API_CLIENTS_SECRET_NAME || API_CLIENTS_SECRET_NAME;
  let clients: ApiClient[];
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    clients = parseApiClients(out.SecretString);
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      // Keep serving the last good list (or the env key) on a transient
      // error, and retry on the next request rather than in 5 minutes.
      console.error(`[external-api] reading ${secretId} failed:`, (err as Error)?.message ?? err);
      return clientsCache?.clients ?? [];
    }
    clients = [];
  }
  clientsCache = { at: now, clients };
  return clients;
}

// The original single key from Amplify Hosting env, kept so Muse / hh keep
// working until their key is in the secret.
function envClient(): ApiClient | null {
  const key = process.env.MUSE_API_KEY;
  const sender = process.env.MUSE_SENDER;
  if (!key || !sender) return null;
  return { name: "muse-env", keyHash: hashApiKey(key), sender };
}

export function withApiKey(handler: ApiHandler): NextApiHandler {
  return async (req, res) => {
    // Auth first — before any config check — so an unauthenticated
    // caller can't probe which pieces are deployed.
    const header = req.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!supplied) return res.status(401).json({ error: "Unauthorized" });

    const env = envClient();
    const client = matchApiClient(supplied, [...(await loadSecretClients()), ...(env ? [env] : [])]);
    if (!client) return res.status(401).json({ error: "Unauthorized" });

    if (!process.env.HOME_AGENT_FUNCTION_NAME) {
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.log(`[external-api] ${client.name} ${req.method} ${req.url?.split("?")[0]}`);
    return handler(req, res, { sender: client.sender, client: client.name });
  };
}

export async function invokeAgent<T = any>(payload: unknown): Promise<T> {
  const out = await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.HOME_AGENT_FUNCTION_NAME,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
  const body = out.Payload ? Buffer.from(out.Payload).toString("utf-8") : "null";
  if (out.FunctionError) {
    throw new Error(`Agent Lambda error: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body) as T;
}

// Tool list is fixed per deployed Lambda version; cache it for the life
// of the SSR container so spec + validation don't pay an invoke each time.
let toolsCache: Promise<ApiTool[]> | null = null;
export function listTools(): Promise<ApiTool[]> {
  if (!toolsCache) {
    toolsCache = invokeAgent<{ tools: ApiTool[] }>({ apiListTools: true })
      .then((r) => r.tools)
      .catch((err) => {
        toolsCache = null;
        throw err;
      });
  }
  return toolsCache;
}

export function missingRequired(tool: ApiTool, input: Record<string, unknown>): string[] {
  return (tool.input_schema.required ?? []).filter(
    (k) => input[k] === undefined || input[k] === null
  );
}

function summaryOf(description: string | undefined, name: string): string {
  if (!description) return name;
  const first = description.split(/(?<=\.)\s/)[0];
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

export function buildOpenApiSpec(tools: ApiTool[], baseUrl: string) {
  const paths: Record<string, unknown> = {
    "/ask": {
      post: {
        operationId: "ask",
        summary: "Ask the household assistant in natural language",
        description:
          "Runs the full home agent (the same one behind WhatsApp) against a free-form " +
          "request and returns its reply plus the tool calls it made. Prefer the specific " +
          "tool operations when you know exactly what to do; use this for open-ended requests.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Agent reply",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    actionsTaken: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { tool: { type: "string" }, result: {} },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
  };

  paths["/uploads"] = {
    post: {
      operationId: "createUpload",
      summary: "Get a presigned URL to upload an image",
      description:
        "Send images this way, not as base64 in a JSON body. 1) POST here with the image's " +
        "contentType. 2) PUT the raw " +
        "bytes to uploadUrl with the returned headers — directly to S3, no bearer key, valid 15 " +
        "minutes. 3) Call add_inventory_photo with the returned s3Key, or save_wardrobe_item " +
        "with it in s3Keys. For a product image already online, skip this and pass its link " +
        "as imageUrls on save_wardrobe_item (or imageUrl on add_inventory_photo).",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                contentType: {
                  type: "string",
                  enum: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/gif"],
                },
              },
              required: ["contentType"],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Upload target",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  uploadUrl: { type: "string" },
                  method: { type: "string", enum: ["PUT"] },
                  headers: { type: "object", additionalProperties: { type: "string" } },
                  s3Key: { type: "string" },
                  expiresIn: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  };

  for (const t of tools) {
    paths[`/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: summaryOf(t.description, t.name),
        description: t.description,
        // read | write | unknown (legacy tools). The hh CLI dry-runs anything but read.
        "x-access": t.access ?? "unknown",
        requestBody: {
          required: true,
          content: { "application/json": { schema: t.input_schema } },
        },
        responses: {
          "200": {
            description: t.output_schema ? "Result" : "Tool result (shape varies per tool)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { result: t.output_schema ?? {} },
                  ...(t.output_schema ? { required: ["result"] } : {}),
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    };
  }

  const errorSchema = {
    type: "object",
    properties: {
      error: { type: "string" },
      details: { description: "Extra context, e.g. the existing item when a save is a duplicate" },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Home Hub",
      version: "1.0.0",
      description:
        "Household management API: tasks, bills, calendar, trips, shopping lists, " +
        "reminders, checklists, notes, health records, inventory and wardrobes (closet, wishlist, " +
        "outfits, trip packing). Times are America/Chicago " +
        "unless a field says otherwise.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      responses: {
        Unauthorized: {
          description: "Missing or invalid API key",
          content: { "application/json": { schema: errorSchema } },
        },
        BadRequest: {
          description: "Invalid input",
          content: { "application/json": { schema: errorSchema } },
        },
      },
    },
    paths,
  };
}

export function baseUrlFor(req: NextApiRequest): string {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3001";
  const proto =
    req.headers["x-forwarded-proto"] ?? (String(host).startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/v1`;
}
