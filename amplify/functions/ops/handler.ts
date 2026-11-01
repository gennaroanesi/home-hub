// ops — backs the runOp AppSync mutation: the web and mobile apps' way into
// lib/ops. AppSync has already checked the caller is in home-users.
// See docs/ops-architecture.md.

import { S3Client } from "@aws-sdk/client-s3";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/ops";
import type { Schema } from "../../data/resource";
import { parseOpInput, runOp } from "../../../lib/ops/registry.js";
import { createS3ImageStorage } from "../../../lib/ops/storage.js";
import type { OpVia } from "../../../lib/ops/context.js";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();
const storage = createS3ImageStorage(new S3Client({}), process.env.HOME_HUB_BUCKET);

interface RunOpArgs {
  name: string;
  input?: unknown; // AWSJSON: string or parsed
  via?: string | null;
}

export const handler = async (event: { arguments: RunOpArgs }): Promise<string> => {
  const { name, input, via } = event.arguments;
  const parsed = parseOpInput(input);
  if ("error" in parsed) return JSON.stringify(parsed);
  const out = await runOp({ client, storage, actor: { via: via === "mobile" ? ("mobile" as OpVia) : "web" } }, name, parsed.input);
  // a.json() return: AppSync wants a JSON string.
  return JSON.stringify(out);
};
