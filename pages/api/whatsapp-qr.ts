// AUTH MODEL: shared-secret via QR_ACCESS_TOKEN env var (not Cognito).
// The /pair page passes the token in the query string. Intentionally
// not wrapped with withHomeUserAuth so the bot can be re-paired even
// when no human session exists. The same token is also forwarded to
// the bot's internal /qr endpoint as its own auth.
import type { NextApiRequest, NextApiResponse } from "next";
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";

const REGION = "us-east-1";
const ecs = new ECSClient({ region: REGION });

async function findBotTaskIp(clusterArn: string): Promise<string | null> {
  const listRes = await ecs.send(
    new ListTasksCommand({ cluster: clusterArn, desiredStatus: "RUNNING" })
  );
  const taskArns = listRes.taskArns;
  if (!taskArns?.length) return null;

  const descRes = await ecs.send(
    new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArns[0]] })
  );
  const eni = descRes.tasks?.[0]?.attachments
    ?.find((a) => a.type === "ElasticNetworkInterface")
    ?.details?.find((d) => d.name === "publicIPv4Address");

  return eni?.value ?? null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = process.env.QR_ACCESS_TOKEN;
  const clusterArn = process.env.WHATSAPP_BOT_CLUSTER_ARN;

  if (!token || !clusterArn) {
    return res.status(500).json({ error: "Bot not configured" });
  }

  // Constant-time-ish check on the request token. Without this, anyone
  // who knows the URL can pull the bot's pairing QR code and link the
  // WhatsApp account to their own phone.
  const supplied = typeof req.query.token === "string" ? req.query.token : "";
  if (supplied.length !== token.length || supplied !== token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const ip = await findBotTaskIp(clusterArn);
    if (!ip) {
      return res.status(503).json({ error: "Bot is not running" });
    }

    const botUrl = `http://${ip}:8080/qr?token=${encodeURIComponent(token)}`;
    const response = await fetch(botUrl, { signal: AbortSignal.timeout(5000) });
    const html = await response.text();

    res.setHeader("Content-Type", "text/html");
    res.status(response.status).send(html);
  } catch (err) {
    res.status(502).json({ error: "Could not reach bot" });
  }
}
