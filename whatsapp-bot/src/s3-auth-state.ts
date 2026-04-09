import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { proto } from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";

const s3 = new S3Client({});

const BUCKET = process.env.S3_BUCKET!;
const PREFIX = process.env.S3_AUTH_PREFIX || "whatsapp-bot/auth";

async function s3Get(key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `${PREFIX}/${key}`,
    }));
    return await res.Body!.transformToString("utf-8");
  } catch (e: any) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function s3Put(key: string, data: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${PREFIX}/${key}`,
    Body: data,
    ContentType: "application/json",
  }));
}

async function s3Delete(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: `${PREFIX}/${key}`,
  }));
}

export async function useS3AuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // Load or initialize creds
  const credsJson = await s3Get("creds.json");
  const creds: AuthenticationCreds = credsJson
    ? JSON.parse(credsJson, BufferJSON.reviver)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const json = await s3Get(`keys/${type}-${id}.json`);
              if (json) {
                let parsed = JSON.parse(json, BufferJSON.reviver);
                if (type === "app-state-sync-key" && parsed) {
                  parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
                }
                data[id] = parsed;
              }
            })
          );
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          const ops: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `keys/${category}-${id}.json`;
              if (value) {
                ops.push(s3Put(key, JSON.stringify(value, BufferJSON.replacer)));
              } else {
                ops.push(s3Delete(key));
              }
            }
          }
          await Promise.all(ops);
        },
      },
    },
    saveCreds: async () => {
      await s3Put("creds.json", JSON.stringify(creds, BufferJSON.replacer));
    },
  };
}
