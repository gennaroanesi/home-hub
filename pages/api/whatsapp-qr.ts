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
