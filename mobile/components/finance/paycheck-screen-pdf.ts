// Open a finance PDF (paystub or invoice, under home/finance/) on the phone,
// through the same endpoint the web uses: GET /api/finance/file?key=…
// (home-users session, here the Bearer token via authedFetch) with
// ?format=json, which answers the 5-minute presigned S3 link instead of
// redirecting to it (a followed redirect could carry the Authorization header
// to S3, which refuses it). The link opens in the in-app Safari sheet like the
// vault documents. No bare S3 URLs. Used by the Paychecks and Invoices screens.

import { Alert } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { authedFetch } from "../../lib/authed-fetch";
import { isServableFinanceKey } from "../../../lib/finance/finance-files";

const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

/** The presigned link to a finance file, or an error to show. */
export async function financeFileUrl(key: string): Promise<{ url: string } | { error: string }> {
  if (!isServableFinanceKey(key)) return { error: "This isn't a finance file." };
  const endpoint = `${WEB_BASE_URL}/api/finance/file?format=json&key=${encodeURIComponent(key)}`;
  let res: Response;
  try {
    res = await authedFetch(endpoint);
  } catch {
    return { error: "Couldn't reach Home Hub. Check your connection and try again." };
  }
  if (res.status === 401) return { error: "Your session expired. Sign in again to open files." };
  if (!res.ok) return { error: `Couldn't get the file (${res.status}).` };
  let body: { url?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url.startsWith("https://")) return { error: "Couldn't get a link to the file." };
  return { url };
}

/** Open the PDF in the in-app browser sheet; alerts on failure. */
export async function openFinancePdf(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const r = await financeFileUrl(key);
  if ("error" in r) {
    Alert.alert("Couldn't open the PDF", r.error);
    return;
  }
  await WebBrowser.openBrowserAsync(r.url);
}
