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

// ── Generic signed GraphQL caller ────────────────────────────────────────────

async function callAppSync<T = any>(query: string, variables: Record<string, any>): Promise<T> {
  const url = new URL(APPSYNC_ENDPOINT);
  const body = JSON.stringify({ query, variables });

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
  return json.data as T;
}

// ── Agent invocation ─────────────────────────────────────────────────────────

const INVOKE_MUTATION = `
  mutation InvokeHomeAgent(
    $message: String!
    $history: AWSJSON
    $sender: String
    $imageS3Keys: [String]
    $chatContext: AWSJSON
  ) {
    invokeHomeAgent(
      message: $message
      history: $history
      sender: $sender
      imageS3Keys: $imageS3Keys
      chatContext: $chatContext
    ) {
      message
      actionsTaken {
        tool
        result
      }
      attachments {
        type
        url
        caption
      }
    }
  }
`;

export interface AgentAttachment {
  type: string; // "image"
  url: string;
  caption?: string | null;
}

interface AgentResponse {
  message: string;
  actionsTaken?: { tool: string; result: any }[];
  attachments?: AgentAttachment[];
}

export interface HistoryAttachment {
  type: "image";
  s3Key: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  // Only populated on user turns — image attachments forwarded in the
  // current or prior turns so the agent handler can rehydrate bytes from
  // S3 and replay them as image content blocks.
  attachments?: HistoryAttachment[];
}

export interface ChatContext {
  channel: "WA_GROUP" | "WA_DM" | "WEB";
  chatJid: string | null;
}

export async function invokeHomeAgent(
  message: string,
  sender: string,
  history: HistoryMessage[] = [],
  imageS3Keys?: string[],
  chatContext?: ChatContext
): Promise<AgentResponse> {
  const data = await callAppSync<{ invokeHomeAgent: AgentResponse }>(INVOKE_MUTATION, {
    message,
    sender,
    // The agent's `history` arg is AWSJSON — must be a serialized string,
    // not an object. AppSync rejects raw objects with a 400 otherwise.
    history: history.length ? JSON.stringify(history) : null,
    // Omit the field entirely (null) when no images — keeps the mutation
    // equivalent to the pre-phase-3 shape for text-only calls.
    imageS3Keys: imageS3Keys && imageS3Keys.length > 0 ? imageS3Keys : null,
    // chatContext is AWSJSON — serialize it.
    chatContext: chatContext ? JSON.stringify(chatContext) : null,
  });
  return data.invokeHomeAgent;
}

// ── Outbound message queue ───────────────────────────────────────────────────

export interface OutboundMessage {
  id: string;
  channel: "WHATSAPP";
  target: "GROUP" | "PERSON";
  personId: string | null;
  groupJid: string | null;
  text: string;
  status: "PENDING" | "SENT" | "FAILED";
  kind: string | null;
}

const LIST_PENDING_QUERY = `
  query ListPending {
    listHomeOutboundMessages(filter: { status: { eq: PENDING } }, limit: 50) {
      items {
        id
        channel
        target
        personId
        groupJid
        text
        status
        kind
      }
    }
  }
`;

export async function listPendingOutboundMessages(): Promise<OutboundMessage[]> {
  const data = await callAppSync<{ listHomeOutboundMessages: { items: OutboundMessage[] } }>(
    LIST_PENDING_QUERY,
    {}
  );
  return data.listHomeOutboundMessages.items ?? [];
}

const UPDATE_OUTBOUND_MUTATION = `
  mutation UpdateOutbound($input: UpdateHomeOutboundMessageInput!) {
    updateHomeOutboundMessage(input: $input) {
      id
      status
    }
  }
`;

export async function markOutboundMessageSent(id: string): Promise<void> {
  await callAppSync(UPDATE_OUTBOUND_MUTATION, {
    input: {
      id,
      status: "SENT",
      sentAt: new Date().toISOString(),
    },
  });
}

export async function markOutboundMessageFailed(id: string, error: string): Promise<void> {
  await callAppSync(UPDATE_OUTBOUND_MUTATION, {
    input: {
      id,
      status: "FAILED",
      error: error.slice(0, 500),
    },
  });
}

// ── Person lookup (for resolving DM targets) ─────────────────────────────────

export interface PersonLite {
  id: string;
  name: string;
  phoneNumber: string | null;
}

const GET_PERSON_QUERY = `
  query GetPerson($id: ID!) {
    getHomePerson(id: $id) {
      id
      name
      phoneNumber
    }
  }
`;

export async function getPerson(id: string): Promise<PersonLite | null> {
  const data = await callAppSync<{ getHomePerson: PersonLite | null }>(GET_PERSON_QUERY, { id });
  return data.getHomePerson;
}

// ── List all persons (for DM phone-number cache) ────────────────────────────

const LIST_PERSONS_QUERY = `
  query ListPersons {
    listHomePeople(limit: 100) {
      items {
        id
        name
        phoneNumber
      }
    }
  }
`;

export async function listPersons(): Promise<PersonLite[]> {
  const data = await callAppSync<{ listHomePeople: { items: PersonLite[] } }>(
    LIST_PERSONS_QUERY,
    {}
  );
  return data.listHomePeople.items ?? [];
}
