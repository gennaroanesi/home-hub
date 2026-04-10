#!/usr/bin/env node
/**
 * One-time Lightroom OAuth helper.
 *
 * Usage:
 *   node scripts/lightroom-auth.mjs
 *
 * Reads ADOBE_CLIENT_ID and ADOBE_CLIENT_SECRET from .env.local, opens
 * the Adobe consent screen in your browser, prompts you to paste the
 * authorization code from the home-hub callback page, exchanges it for
 * an access + refresh token, and writes the refresh token back to
 * .env.local as LIGHTROOM_REFRESH_TOKEN.
 *
 * The refresh token lasts ~14 days. When it expires, re-run this script.
 *
 * Adobe credential setup (Adobe Developer Console):
 *   - OAuth Web App credential with Lightroom Services API
 *   - Default redirect URI: https://home.cristinegennaro.com/api/lightroom/callback
 *   - Scopes: openid, AdobeID, lr_partner_apis, offline_access
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { exec } from "child_process";

const REDIRECT_URI = "https://home.cristinegennaro.com/api/lightroom/callback";
const SCOPES = "openid,AdobeID,lr_partner_apis,offline_access";
const AUTH_URL = "https://ims-na1.adobelogin.com/ims/authorize/v2";
const TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";

const ENV_FILE = path.resolve(process.cwd(), ".env.local");

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`Error: ${ENV_FILE} not found`);
    process.exit(1);
  }
  const content = fs.readFileSync(ENV_FILE, "utf-8");
  const env = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { env, content };
}

function saveEnvVar(content, key, value) {
  const escaped = value.includes("\n") || value.includes(" ") ? `"${value}"` : value;
  const line = `${key}=${escaped}`;
  if (new RegExp(`^${key}=`, "m").test(content)) {
    return content.replace(new RegExp(`^${key}=.*$`, "m"), line);
  }
  return (content.endsWith("\n") ? content : content + "\n") + line + "\n";
}

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`(Could not open browser automatically — open the URL manually)`);
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const { env, content } = loadEnv();
  const clientId = env.ADOBE_CLIENT_ID;
  const clientSecret = env.ADOBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Error: ADOBE_CLIENT_ID and ADOBE_CLIENT_SECRET must be set in .env.local");
    process.exit(1);
  }

  // Build the consent URL
  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);

  console.log("\n┌─ Lightroom auth ─────────────────────────────────────────");
  console.log("│");
  console.log("│  Opening this URL in your browser:");
  console.log("│");
  console.log(`│  ${authUrl.toString()}`);
  console.log("│");
  console.log("│  After approving, copy the code from the callback page");
  console.log("│  and paste it below.");
  console.log("│");
  console.log("└──────────────────────────────────────────────────────────\n");

  openInBrowser(authUrl.toString());

  const code = await prompt("Authorization code: ");
  if (!code) {
    console.error("No code provided, aborting");
    process.exit(1);
  }

  console.log("\nExchanging code for tokens…");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Token exchange failed: ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  const tokens = await res.json();
  if (!tokens.refresh_token) {
    console.error("Response did not include a refresh_token. Make sure 'offline_access' is in the scopes.");
    console.error(JSON.stringify(tokens, null, 2));
    process.exit(1);
  }

  console.log("✓ Got tokens");
  console.log(`  access_token expires in: ${tokens.expires_in}s`);
  console.log(`  refresh_token length: ${tokens.refresh_token.length}`);

  let next = saveEnvVar(content, "LIGHTROOM_REFRESH_TOKEN", tokens.refresh_token);
  fs.writeFileSync(ENV_FILE, next);

  console.log(`\n✓ Saved LIGHTROOM_REFRESH_TOKEN to ${ENV_FILE}`);
  console.log("\nYou can now run: node scripts/lightroom-import.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
