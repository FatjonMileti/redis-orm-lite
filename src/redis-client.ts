import { createClient, RedisClientType, RedisDefaultModules, RedisFunctions, RedisScripts } from "redis";
import { configureRedisORM } from "./retry";
import type { RedisRetryOptions } from "./retry";

let client: RedisClientType<RedisDefaultModules, RedisFunctions, RedisScripts>;

export interface ConnectRedisOptions {
  /**
   * Global retry policy applied to all subsequent ORM operations.
   * Retry stays disabled unless `retry.retries > 0` is set.
   */
  retry?: RedisRetryOptions;
}

export async function connectRedis(url: string, options?: ConnectRedisOptions) {
  if (options?.retry) {
    configureRedisORM({ retry: options.retry });
  }
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
