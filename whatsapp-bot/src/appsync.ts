import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;
const REGION = process.env.AWS_REGION || "us-east-1";

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "appsync",
  sha256: Sha256,
});

const INVOKE_MUTATION = `
  mutation InvokeHomeAgent($message: String!, $history: AWSJSON, $sender: String) {
    invokeHomeAgent(message: $message, history: $history, sender: $sender) {
      message
      actionsTaken {
        tool
        result
      }
    }
  }
`;

interface AgentResponse {
  message: string;
  actionsTaken?: { tool: string; result: any }[];
}

export async function invokeHomeAgent(message: string, sender: string): Promise<AgentResponse> {
  const url = new URL(APPSYNC_ENDPOINT);

  const body = JSON.stringify({
    query: INVOKE_MUTATION,
    variables: { message, sender },
  });

  const request = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      "Content-Type": "application/json",
      host: url.hostname,
    },
    body,
  });

  const signed = await signer.sign(request);

  const res = await fetch(APPSYNC_ENDPOINT, {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AppSync request failed: ${res.status} ${text}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    throw new Error(`AppSync errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data.invokeHomeAgent;
}
