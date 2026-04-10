import type { NextApiRequest, NextApiResponse } from "next";

/**
 * GET /api/lightroom/callback
 *
 * Adobe IMS redirects here after the user approves the consent screen.
 * The query string contains either ?code=... (success) or ?error=...
 *
 * This is part of a manual code-copy OAuth flow used by the local
 * lightroom-import script. The script can't run a localhost callback
 * server because Adobe's web-app credential requires HTTPS, so we use
 * the production app's HTTPS endpoint as the redirect target and just
 * render the code in plain HTML for the user to copy back into their
 * terminal. No tokens or sessions touch the server.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { code, error, error_description: errorDescription } = req.query;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (error) {
    return res.status(400).send(htmlPage({
      title: "Lightroom auth — error",
      body: `
        <h1>Authorization failed</h1>
        <p><strong>${escapeHtml(String(error))}</strong></p>
        <p>${escapeHtml(String(errorDescription ?? ""))}</p>
      `,
    }));
  }

  if (typeof code !== "string" || !code) {
    return res.status(400).send(htmlPage({
      title: "Lightroom auth — missing code",
      body: `
        <h1>No authorization code in response</h1>
        <p>This page is the OAuth callback for the Lightroom import script.
        Open it via the script's printed authorization URL.</p>
      `,
    }));
  }

  return res.status(200).send(htmlPage({
    title: "Lightroom auth — code",
    body: `
      <h1>Authorization code</h1>
      <p>Copy this code and paste it back into your terminal:</p>
      <pre id="code">${escapeHtml(code)}</pre>
      <button onclick="copyCode()">Copy to clipboard</button>
      <p style="margin-top:2rem;color:#666;font-size:0.9rem">
        You can close this tab once the script has accepted the code.
      </p>
      <script>
        function copyCode() {
          const c = document.getElementById('code').innerText;
          navigator.clipboard.writeText(c).then(() => {
            const b = document.querySelector('button');
            b.innerText = 'Copied ✓';
            setTimeout(() => { b.innerText = 'Copy to clipboard'; }, 1500);
          });
        }
      </script>
    `,
  }));
}

function htmlPage({ title, body }: { title: string; body: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 720px; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5;
           color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    pre { background: #f0f0f0; padding: 1rem; border-radius: 6px; overflow-x: auto;
          word-break: break-all; white-space: pre-wrap; font-size: 0.85rem;
          border: 1px solid #e0e0e0; }
    button { padding: 0.5rem 1rem; background: #1a1a1a; color: #fff;
             border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
