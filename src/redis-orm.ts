import { getRedisClient } from "./redis-client";
import { v4 as uuidv4 } from "uuid";

type QueryOperator<T> = {
  $gt?: T;
  $lt?: T;
  $gte?: T;
  $lte?: T;
  $in?: T[];
  $nin?: T[];
  $ne?: T;
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
    const id = doc.id ?? uuidv4();
    const newDoc = { ...doc, id };
    await client.set(this.getKey(id), JSON.stringify(newDoc));
    return newDoc;
  }

  // -----------------------
  // MATCH LOGIC
  // -----------------------
  private _matches(doc: T, query: Query<T>): boolean {
    for (const [field, cond] of Object.entries(query)) {
      const value = (doc as any)[field];

      if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
        const op = cond as QueryOperator<any>;

        if (op.$gt !== undefined && !(value > op.$gt)) return false;
        if (op.$gte !== undefined && !(value >= op.$gte)) return false;
        if (op.$lt !== undefined && !(value < op.$lt)) return false;
        if (op.$lte !== undefined && !(value <= op.$lte)) return false;
        if (op.$in !== undefined && !op.$in.includes(value)) return false;
        if (op.$nin !== undefined && op.$nin.includes(value)) return false;
        if (op.$ne !== undefined && value === op.$ne) return false;
      } else {
        if (value !== cond) return false;
      }
    }

    return true;
  }

  // -----------------------
  // BASIC FIND FUNCTIONS
  // -----------------------

  async find(query: Query<T> = {}): Promise<T[]> {
    const client = getRedisClient();
    const keys = await client.keys(`${this.modelName}:*`);
    const results: T[] = [];

    for (const key of keys) {
      const data = await client.get(key);
      if (!data) continue;
      const doc: T = JSON.parse(data);

      if (this._matches(doc, query)) {
        results.push(doc);
      }
    }
    return results;
  }

  async findOne(query: Query<T> = {}): Promise<T | null> {
    const client = getRedisClient();
    const keys = await client.keys(`${this.modelName}:*`);

    for (const key of keys) {
      const data = await client.get(key);
      if (!data) continue;
      const doc: T = JSON.parse(data);

      if (this._matches(doc, query)) {
        return doc;
      }
    }

    return null;
  }

  async findById(id: string): Promise<T | null> {
    const client = getRedisClient();
    const data = await client.get(this.getKey(id));
    return data ? JSON.parse(data) : null;
  }

  // -----------------------
  // UPDATE OPERATIONS
  // -----------------------

  async updateMany(query: Query<T>, update: Partial<T>): Promise<number> {
    const docs = await this.find(query);
    const client = getRedisClient();
    let count = 0;

    for (const doc of docs) {
      if (!doc.id) continue;
      const updated = { ...doc, ...update };
      await client.set(this.getKey(doc.id), JSON.stringify(updated));
      count++;
    }
    return count;
  }

  async updateOne(query: Query<T>, update: Partial<T>): Promise<T | null> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return null;

    const client = getRedisClient();
    const updated = { ...doc, ...update };
    await client.set(this.getKey(doc.id), JSON.stringify(updated));
    return updated;
  }

  async findOneAndUpdate(
    query: Query<T>,
    update: Partial<T>,
    options: { returnNew?: boolean } = {}
  ): Promise<T | null> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return null;

    const client = getRedisClient();
    const updated = { ...doc, ...update };

    await client.set(this.getKey(doc.id), JSON.stringify(updated));

    return options.returnNew ? updated : doc;
  }

  // -----------------------
  // DELETE OPERATIONS
  // -----------------------

  async deleteMany(query: Query<T> = {}): Promise<number> {
    const docs = await this.find(query);
    const client = getRedisClient();
    let count = 0;

    for (const doc of docs) {
      if (!doc.id) continue;
      await client.del(this.getKey(doc.id));
      count++;
    }
    return count;
  }

  async deleteOne(query: Query<T> = {}): Promise<number> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return 0;

    const client = getRedisClient();
    await client.del(this.getKey(doc.id));
    return 1;
  }

  async findOneAndDelete(query: Query<T>): Promise<T | null> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return null;

    const client = getRedisClient();
    await client.del(this.getKey(doc.id));

    return doc;
  }

  // -----------------------
  // COUNT
  // -----------------------

  async countDocuments(query: Query<T> = {}): Promise<number> {
    const docs = await this.find(query);
    return docs.length;
  }
}
