import express from "express";
import QRCode from "qrcode";

const app = express();
const QR_ACCESS_TOKEN = process.env.QR_ACCESS_TOKEN;

let currentQR: string | null = null;
let connectionStatus: string = "disconnected";

export function updateQR(qr: string | null) {
  currentQR = qr;
}

export function updateStatus(status: string) {
  connectionStatus = status;
}

// Token auth middleware for /qr endpoint
function requireToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!QR_ACCESS_TOKEN) {
    // No token configured — deny all access
    res.status(403).send("QR_ACCESS_TOKEN not configured");
    return;
  }
  const token = req.query.token as string;
  if (token !== QR_ACCESS_TOKEN) {
    res.status(403).send("Forbidden");
    return;
  }
  next();
}

app.get("/qr", requireToken, async (_req, res) => {
  if (connectionStatus === "open") {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Connected to WhatsApp</h2>
        <p>The bot is running.</p>
      </body></html>
    `);
    return;
  }

  if (!currentQR) {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Waiting for QR code...</h2>
        <p>Status: ${connectionStatus}</p>
        <script>setTimeout(() => location.reload(), 3000)</script>
      </body></html>
    `);
    return;
  }

  const svg = await QRCode.toString(currentQR, { type: "svg" });
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>Scan with WhatsApp</h2>
      <p>Open WhatsApp > Linked Devices > Link a Device</p>
      <div style="max-width:300px;margin:20px auto">${svg}</div>
      <p style="color:#666">QR refreshes automatically</p>
      <script>setTimeout(() => location.reload(), 20000)</script>
    </body></html>
  `);
});

app.get("/health", (_req, res) => {
  res.json({ status: connectionStatus });
});

export function startServer(port = 8080) {
  app.listen(port, () => {
    console.log(`QR server listening on :${port}`);
  });
}
