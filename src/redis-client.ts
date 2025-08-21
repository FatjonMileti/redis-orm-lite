import Redis from "ioredis";

let client: Redis | null = null;

/**
 * Connects to Redis with the provided URL.
 */
export function connectRedis(redisUrl: string) {
  client = new Redis(redisUrl);

  client.on("connect", () => {
    console.log("✅ Connected to Redis");
  });

  client.on("error", (err) => {
    console.error("❌ Redis connection error:", err);
  });

  return client;
}

/**
 * Returns the active Redis client.
 */
export function getRedisClient(): Redis {
  if (!client) {
    throw new Error("Redis client not initialized. Call connectRedis() first.");
  }
  return client;
}
