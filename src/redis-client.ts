import { createClient, RedisClientType, RedisDefaultModules, RedisFunctions, RedisScripts } from "redis";

let client: RedisClientType<RedisDefaultModules, RedisFunctions, RedisScripts>;

export async function connectRedis(url: string) {
  client = createClient({ url }) as RedisClientType<RedisDefaultModules, RedisFunctions, RedisScripts>;

  client.on("error", (err: Error) => {
    console.error("Redis Client Error", err);
  });

  await client.connect();
  return client;
}

export function getRedisClient() {
  if (!client) {
    throw new Error("Redis client not initialized. Call connectRedis first.");
  }
  return client;
}
