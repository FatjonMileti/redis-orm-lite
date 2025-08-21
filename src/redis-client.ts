// src/redis-client.ts
import { createClient } from "redis";

let client: ReturnType<typeof createClient>;

export async function connectRedis(url: string) {
  client = createClient({ url });

  client.on("error", (err: Error) => {
    console.error("Redis Client Error", err);
  });

  await client.connect();
  return client;
}

export function getRedisClient() {
  if (!client) {
    throw new Error("Redis client not initialized. Call initRedis first.");
  }
  return client;
}
