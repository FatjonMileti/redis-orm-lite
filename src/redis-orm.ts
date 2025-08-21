// src/redis-orm.ts
import { getRedisClient } from "./redis-client";
import { v4 as uuidv4 } from "uuid";

type QueryOperator<T> = {
  $gt?: T;
  $lt?: T;
  $in?: T[];
};

type Query<T> = Partial<{
  [K in keyof T]: T[K] | QueryOperator<T[K]>;
}>;

export class RedisModel<T extends { id?: string }> {
  constructor(private modelName: string) {}

  private getKey(id: string) {
    return `${this.modelName}:${id}`;
  }

  async create(doc: T): Promise<T> {
    const client = getRedisClient();
    const id = doc.id || uuidv4();
    const newDoc = { ...doc, id };
    await client.set(this.getKey(id), JSON.stringify(newDoc));
    return newDoc;
  }

  async find(query: Query<T> = {}): Promise<T[]> {
    const client = getRedisClient();
    const keys = await client.keys(`${this.modelName}:*`);
    const results: T[] = [];

    for (const key of keys) {
      const data = await client.get(key);
      if (!data) continue;
      const doc: T = JSON.parse(data);

      let match = true;
      for (const [field, condition] of Object.entries(query)) {
        const value = (doc as any)[field];

        if (typeof condition === "object" && condition !== null) {
          const cond = condition as QueryOperator<any>;

          if (cond.$gt !== undefined && !(value > cond.$gt)) match = false;
          if (cond.$lt !== undefined && !(value < cond.$lt)) match = false;
          if (cond.$in !== undefined && !cond.$in.includes(value)) match = false;
        } else {
          if (value !== condition) match = false;
        }
      }

      if (match) results.push(doc);
    }

    return results;
  }

  async findById(id: string): Promise<T | null> {
    const client = getRedisClient();
    const data = await client.get(this.getKey(id));
    return data ? JSON.parse(data) : null;
  }

  async deleteMany(query: Query<T> = {}): Promise<number> {
    const docs = await this.find(query);
    const client = getRedisClient();
    let deleted = 0;

    for (const doc of docs) {
      if (!doc.id) continue;
      await client.del(this.getKey(doc.id));
      deleted++;
    }

    return deleted;
  }

  async updateMany(query: Query<T>, update: Partial<T>): Promise<number> {
    const docs = await this.find(query);
    const client = getRedisClient();
    let updated = 0;

    for (const doc of docs) {
      if (!doc.id) continue;
      const updatedDoc = { ...doc, ...update };
      await client.set(this.getKey(doc.id), JSON.stringify(updatedDoc));
      updated++;
    }

    return updated;
  }

  async countDocuments(query: Query<T> = {}): Promise<number> {
    const docs = await this.find(query);
    return docs.length;
  }
}
