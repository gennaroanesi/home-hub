// Server-side GraphQL call to AppSync as the signed-in caller (their
// Cognito access token), so model auth rules still apply. For API routes
// that need a row the client shouldn't hand them (e.g. a document's file key).

import outputs from "@/amplify_outputs.json";

export async function appsyncAsUser<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(outputs.data.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error(`AppSync ${res.status}`);
  return json.data;
}
