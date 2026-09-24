/**
 * Shared plumbing for the external API gateway at /api/muse/*.
 *
 * External assistants (Meta's Muse) can't do a Cognito login, so this
 * gateway uses a single static bearer key and acts as one household
 * member (MUSE_SENDER). Every request is forwarded to the home-agent
 * Lambda, which owns the tool definitions and executeTool — the
 * gateway never touches DynamoDB itself, so the tool surface and the
 * OpenAPI spec stay in lockstep with what the WhatsApp agent can do.
 *
 * Env vars (Amplify Hosting → forwarded to SSR via amplify.yml):
 *   MUSE_API_KEY             — the bearer secret
 *   MUSE_SENDER              — household member name the key acts as
 *   HOME_AGENT_FUNCTION_NAME — written by backend postBuild from stack outputs
 */

import { createHash, timingSafeEqual } from "crypto";
import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({ region: "us-east-1" });

export type MuseTool = {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type MuseContext = { sender: string };

export type MuseHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  ctx: MuseContext
) => void | Promise<void>;

// Hash both sides so the comparison is fixed-length and doesn't leak
// the key's length through timing.
function keyMatches(supplied: string, expected: string): boolean {
  const digest = (v: string) => new Uint8Array(createHash("sha256").update(v).digest());
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function withMuseAuth(handler: MuseHandler): NextApiHandler {
  return async (req, res) => {
    // Auth first — before any config check — so an unauthenticated
    // caller can't probe which pieces are deployed.
    const expected = process.env.MUSE_API_KEY ?? "";
    const header = req.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!expected || !supplied || !keyMatches(supplied, expected)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sender = process.env.MUSE_SENDER;
    if (!sender || !process.env.HOME_AGENT_FUNCTION_NAME) {
      return res.status(500).json({ error: "Server misconfigured" });
    }
    return handler(req, res, { sender });
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
let toolsCache: Promise<MuseTool[]> | null = null;
export function listTools(): Promise<MuseTool[]> {
  if (!toolsCache) {
    toolsCache = invokeAgent<{ tools: MuseTool[] }>({ apiListTools: true })
      .then((r) => r.tools)
      .catch((err) => {
        toolsCache = null;
        throw err;
      });
  }
  return toolsCache;
}

export function missingRequired(tool: MuseTool, input: Record<string, unknown>): string[] {
  return (tool.input_schema.required ?? []).filter(
    (k) => input[k] === undefined || input[k] === null
  );
}

function summaryOf(description: string | undefined, name: string): string {
  if (!description) return name;
  const first = description.split(/(?<=\.)\s/)[0];
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

export function buildOpenApiSpec(tools: MuseTool[], baseUrl: string) {
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

  for (const t of tools) {
    paths[`/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: summaryOf(t.description, t.name),
        description: t.description,
        requestBody: {
          required: true,
          content: { "application/json": { schema: t.input_schema } },
        },
        responses: {
          "200": {
            description: "Tool result (shape varies per tool)",
            content: {
              "application/json": {
                schema: { type: "object", properties: { result: {} } },
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
    properties: { error: { type: "string" } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Home Hub",
      version: "1.0.0",
      description:
        "Household management API: tasks, bills, calendar, trips, shopping lists, " +
        "reminders, checklists, health records and inventory. Times are America/Chicago " +
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
  return `${proto}://${host}/api/muse`;
}
