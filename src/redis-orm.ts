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

type SortConfig<T> = Partial<Record<keyof T, 1 | -1>>;

export class RedisError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "RedisError";
  }
}

async function scanKeys(pattern: string): Promise<string[]> {
  const client = getRedisClient();
  const keys: string[] = [];
  let cursor = 0;

  try {
    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (cursor !== 0);

    return keys;
  } catch (err) {
    throw new RedisError(`Failed to scan keys with pattern "${pattern}"`, err);
  }
}

export class QueryBuilder<T extends { id?: string }> {
  private sortConfig: SortConfig<T> = {};
  private skipCount = 0;
  private limitCount: number | undefined;

  constructor(
    private modelName: string,
    private query: Query<T> = {}
  ) {}

  sort(sort: SortConfig<T>): this {
    this.sortConfig = sort;
    return this;
  }

  skip(n: number): this {
    this.skipCount = n;
    return this;
  }

  limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  private matches(doc: T): boolean {
    for (const [field, cond] of Object.entries(this.query)) {
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

  async exec(): Promise<T[]> {
    const keys = await scanKeys(`${this.modelName}:*`);
    const results: T[] = [];

    try {
      const client = getRedisClient();

      for (const key of keys) {
        const data = await client.get(key);
        if (!data) continue;
        const doc: T = JSON.parse(data);

        if (this.matches(doc)) {
          results.push(doc);
        }
      }
    } catch (err) {
      if (err instanceof RedisError) throw err;
      throw new RedisError("Failed to execute query", err);
    }

    const entries = Object.entries(this.sortConfig) as [keyof T, 1 | -1][];
    if (entries.length > 0) {
      results.sort((a, b) => {
        for (const [field, order] of entries) {
          const aVal = a[field];
          const bVal = b[field];
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          if (aVal < bVal) return -1 * order;
          if (aVal > bVal) return 1 * order;
        }
        return 0;
      });
    }

    let sliced = results;
    if (this.skipCount > 0) sliced = sliced.slice(this.skipCount);
    if (this.limitCount !== undefined) sliced = sliced.slice(0, this.limitCount);

    return sliced;
  }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

export class RedisModel<T extends { id?: string }> {
  constructor(private modelName: string) {}

  private getKey(id: string) {
    return `${this.modelName}:${id}`;
  }

  async create(doc: T): Promise<T> {
    try {
      const client = getRedisClient();
      const id = doc.id ?? uuidv4();
      const newDoc = { ...doc, id };
      await client.set(this.getKey(id), JSON.stringify(newDoc));
      return newDoc;
    } catch (err) {
      throw new RedisError("Failed to create document", err);
    }
  }

  find(query: Query<T> = {}): QueryBuilder<T> {
    return new QueryBuilder<T>(this.modelName, query);
  }

  async findOne(query: Query<T> = {}): Promise<T | null> {
    try {
      const keys = await scanKeys(`${this.modelName}:*`);

      for (const key of keys) {
        const data = await getRedisClient().get(key);
        if (!data) continue;
        const doc: T = JSON.parse(data);

        if (this.matches(doc, query)) {
          return doc;
        }
      }

      return null;
    } catch (err) {
      if (err instanceof RedisError) throw err;
      throw new RedisError("Failed to find document", err);
    }
  }

  async findById(id: string): Promise<T | null> {
    try {
      const client = getRedisClient();
      const data = await client.get(this.getKey(id));
      return data ? JSON.parse(data) : null;
    } catch (err) {
      throw new RedisError(`Failed to find document by id "${id}"`, err);
    }
  }

  async updateMany(query: Query<T>, update: Partial<T>): Promise<number> {
    const docs = await this.find(query).exec();
    const client = getRedisClient();
    let count = 0;

    try {
      for (const doc of docs) {
        if (!doc.id) continue;
        const updated = { ...doc, ...update };
        await client.set(this.getKey(doc.id), JSON.stringify(updated));
        count++;
      }
    } catch (err) {
      throw new RedisError("Failed to update documents", err);
    }

    return count;
  }

  async updateOne(query: Query<T>, update: Partial<T>): Promise<T | null> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return null;

    try {
      const client = getRedisClient();
      const updated = { ...doc, ...update };
      await client.set(this.getKey(doc.id), JSON.stringify(updated));
      return updated;
    } catch (err) {
      throw new RedisError("Failed to update document", err);
    }
  }

  async findOneAndUpdate(
    query: Query<T>,
    update: Partial<T>,
    options: { returnNew?: boolean } = {}
  ): Promise<T | null> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return null;

    try {
      const client = getRedisClient();
      const updated = { ...doc, ...update };
      await client.set(this.getKey(doc.id), JSON.stringify(updated));
      return options.returnNew ? updated : doc;
    } catch (err) {
      throw new RedisError("Failed to find and update document", err);
    }
  }

  async deleteMany(query: Query<T> = {}): Promise<number> {
    const docs = await this.find(query).exec();
    const client = getRedisClient();
    let count = 0;

    try {
      for (const doc of docs) {
        if (!doc.id) continue;
        await client.del(this.getKey(doc.id));
        count++;
      }
    } catch (err) {
      throw new RedisError("Failed to delete documents", err);
    }

    return count;
  }

  async deleteOne(query: Query<T> = {}): Promise<number> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return 0;

    try {
      const client = getRedisClient();
      await client.del(this.getKey(doc.id));
      return 1;
    } catch (err) {
      throw new RedisError("Failed to delete document", err);
    }
  }

  async findOneAndDelete(query: Query<T>): Promise<T | null> {
    const doc = await this.findOne(query);
    if (!doc || !doc.id) return null;

    try {
      const client = getRedisClient();
      await client.del(this.getKey(doc.id));
      return doc;
    } catch (err) {
      throw new RedisError("Failed to find and delete document", err);
    }
  }

  async countDocuments(query: Query<T> = {}): Promise<number> {
    const docs = await this.find(query).exec();
    return docs.length;
  }

  private matches(doc: T, query: Query<T>): boolean {
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
}
