import { getRedisClient } from "./redis-client";
import { v4 as uuidv4 } from "uuid";
import { executeRedisCommand } from "./retry";
import type { OperationOptions, RedisRetryOptions } from "./retry";

export type { OperationOptions, RedisRetryOptions };

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

/**
 * Extra options for `findOneAndUpdate`, which already takes an options
 * argument. `returnNew` keeps its meaning; `retry` / `signal` are additive
 * and optional.
 */
export interface FindOneAndUpdateOptions {
  returnNew?: boolean;
  retry?: RedisRetryOptions;
  signal?: AbortSignal;
}

async function scanKeys(
  pattern: string,
  options?: OperationOptions
): Promise<string[]> {
  const client = getRedisClient();

  try {
    // One retry unit = the whole SCAN loop. A mid-loop failure restarts
    // the scan from cursor 0 (SCAN is a read: always safe to retry).
    return await executeRedisCommand(
      "scan",
      async () => {
        const keys: string[] = [];
        let cursor = 0;

        do {
          const result = await client.scan(cursor, {
            MATCH: pattern,
            COUNT: 100,
          });
          cursor = result.cursor;
          keys.push(...result.keys);
        } while (cursor !== 0);

        return keys;
      },
      options
    );
  } catch (err) {
    throw new RedisError(`Failed to scan keys with pattern "${pattern}"`, err);
  }
}

export class QueryBuilder<T extends { id?: string }> {
  private sortConfig: SortConfig<T> = {};
  private skipCount = 0;
  private limitCount: number | undefined;
  private operationOptions?: OperationOptions;

  constructor(
    private modelName: string,
    private query: Query<T> = {},
    options?: OperationOptions
  ) {
    this.operationOptions = options;
  }

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

  /**
   * Override the retry policy for this query only.
   * Merged over (wins against) the global configuration.
   */
  withRetry(retry: RedisRetryOptions): this {
    this.operationOptions = { ...this.operationOptions, retry };
    return this;
  }

  /** Attach an AbortSignal cancelling retry waits for this query. */
  withSignal(signal: AbortSignal): this {
    this.operationOptions = { ...this.operationOptions, signal };
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

  async exec(options?: OperationOptions): Promise<T[]> {
    const effective: OperationOptions | undefined =
      options ?? this.operationOptions;
    const keys = await scanKeys(`${this.modelName}:*`, effective);
    const results: T[] = [];

    try {
      const client = getRedisClient();

      for (const key of keys) {
        const data = await executeRedisCommand(
          "get",
          () => client.get(key),
          effective
        );
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

  async create(doc: T, options?: OperationOptions): Promise<T> {
    try {
      const client = getRedisClient();
      const id = doc.id ?? uuidv4();
      const newDoc = { ...doc, id };
      await executeRedisCommand(
        "set",
        () => client.set(this.getKey(id), JSON.stringify(newDoc)),
        options
      );
      return newDoc;
    } catch (err) {
      throw new RedisError("Failed to create document", err);
    }
  }

  find(query: Query<T> = {}, options?: OperationOptions): QueryBuilder<T> {
    return new QueryBuilder<T>(this.modelName, query, options);
  }

  async findOne(
    query: Query<T> = {},
    options?: OperationOptions
  ): Promise<T | null> {
    try {
      const keys = await scanKeys(`${this.modelName}:*`, options);

      for (const key of keys) {
        const data = await executeRedisCommand(
          "get",
          () => getRedisClient().get(key),
          options
        );
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

  async findById(
    id: string,
    options?: OperationOptions
  ): Promise<T | null> {
    try {
      const client = getRedisClient();
      const data = await executeRedisCommand(
        "get",
        () => client.get(this.getKey(id)),
        options
      );
      return data ? JSON.parse(data) : null;
    } catch (err) {
      throw new RedisError(`Failed to find document by id "${id}"`, err);
    }
  }

  async updateMany(
    query: Query<T>,
    update: Partial<T>,
    options?: OperationOptions
  ): Promise<number> {
    const docs = await this.find(query, options).exec();
    const client = getRedisClient();
    let count = 0;

    try {
      for (const doc of docs) {
        if (!doc.id) continue;
        const updated = { ...doc, ...update };
        await executeRedisCommand(
          "set",
          () => client.set(this.getKey(doc.id as string), JSON.stringify(updated)),
          options
        );
        count++;
      }
    } catch (err) {
      throw new RedisError("Failed to update documents", err);
    }

    return count;
  }

  async updateOne(
    query: Query<T>,
    update: Partial<T>,
    options?: OperationOptions
  ): Promise<T | null> {
    const doc = await this.findOne(query, options);
    if (!doc || !doc.id) return null;

    try {
      const client = getRedisClient();
      const updated = { ...doc, ...update };
      await executeRedisCommand(
        "set",
        () => client.set(this.getKey(doc.id as string), JSON.stringify(updated)),
        options
      );
      return updated;
    } catch (err) {
      throw new RedisError("Failed to update document", err);
    }
  }

  async findOneAndUpdate(
    query: Query<T>,
    update: Partial<T>,
    options: FindOneAndUpdateOptions = {}
  ): Promise<T | null> {
    const { returnNew, retry, signal } = options;
    const opOptions: OperationOptions | undefined =
      retry || signal ? { retry, signal } : undefined;
    const doc = await this.findOne(query, opOptions);
    if (!doc || !doc.id) return null;

    try {
      const client = getRedisClient();
      const updated = { ...doc, ...update };
      await executeRedisCommand(
        "set",
        () => client.set(this.getKey(doc.id as string), JSON.stringify(updated)),
        opOptions
      );
      return returnNew ? updated : doc;
    } catch (err) {
      throw new RedisError("Failed to find and update document", err);
    }
  }

  async deleteMany(
    query: Query<T> = {},
    options?: OperationOptions
  ): Promise<number> {
    const docs = await this.find(query, options).exec();
    const client = getRedisClient();
    let count = 0;

    try {
      for (const doc of docs) {
        if (!doc.id) continue;
        await executeRedisCommand(
          "del",
          () => client.del(this.getKey(doc.id as string)),
          options
        );
        count++;
      }
    } catch (err) {
      throw new RedisError("Failed to delete documents", err);
    }

    return count;
  }

  async deleteOne(
    query: Query<T> = {},
    options?: OperationOptions
  ): Promise<number> {
    const doc = await this.findOne(query, options);
    if (!doc || !doc.id) return 0;

    try {
      const client = getRedisClient();
      await executeRedisCommand(
        "del",
        () => client.del(this.getKey(doc.id as string)),
        options
      );
      return 1;
    } catch (err) {
      throw new RedisError("Failed to delete document", err);
    }
  }

  async findOneAndDelete(
    query: Query<T>,
    options?: OperationOptions
  ): Promise<T | null> {
    const doc = await this.findOne(query, options);
    if (!doc || !doc.id) return null;

    try {
      const client = getRedisClient();
      await executeRedisCommand(
        "del",
        () => client.del(this.getKey(doc.id as string)),
        options
      );
      return doc;
    } catch (err) {
      throw new RedisError("Failed to find and delete document", err);
    }
  }

  async countDocuments(
    query: Query<T> = {},
    options?: OperationOptions
  ): Promise<number> {
    const docs = await this.find(query, options).exec();
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
