// Amplify bootstrap for the mobile app.
//
// We share the exact same `amplify_outputs.json` the Next.js app uses,
// so the mobile app talks to the same Cognito user pool, the same
// AppSync endpoint, and gets the same generated `Schema` types from
// `amplify/data/resource.ts`. Single source of truth.
//
// Two RN-specific bits (vs. the web setup):
//   1. AsyncStorage as the auth-session store. Amplify defaults to
//      window.localStorage on web — there is no localStorage in RN.
//   2. The `@aws-amplify/react-native` polyfills (UUID, crypto, etc.)
//      have to be imported before anything calls into aws-amplify.
import "@aws-amplify/react-native";
import "react-native-get-random-values";

import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { generateClient } from "aws-amplify/data";

import outputs from "../../amplify_outputs.json";
import type { Schema } from "../../amplify/data/resource";

let configured = false;

export function configureAmplify(): void {
  if (configured) return;
  Amplify.configure(outputs);
  cognitoUserPoolsTokenProvider.setKeyValueStorage(AsyncStorage);
  configured = true;
}

// Lazy-initialized data client. Components import `getClient()` rather
// than a top-level constant so the configuration step always runs first.
let _client: ReturnType<typeof generateClient<Schema>> | null = null;
export function getClient() {
  configureAmplify();
  if (!_client) _client = generateClient<Schema>({ authMode: "userPool" });
  return _client;
}
