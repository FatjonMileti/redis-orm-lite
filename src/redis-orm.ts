// redis-orm.ts
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

type SchemaDefinition<T> = { [K in keyof T]: any };

type QueryOperators<T> = {
  [K in keyof T]?:
    | T[K]
    | {
        $gt?: T[K];
        $gte?: T[K];
        $lt?: T[K];
        $lte?: T[K];
        $in?: T[K][];
        $nin?: T[K][];
        $ne?: T[K];
      };
};

// ---------- Query Builder ----------
class QueryBuilder<T> {
  private dataFetcher: () => Promise<T[]>;
  private _sort: Record<string, 1 | -1> | null = null;
  private _limit: number | null = null;
  private _skip: number = 0;

  constructor(dataFetcher: () => Promise<T[]>) {
    this.dataFetcher = dataFetcher;
  }

  sort(fields: Record<string, 1 | -1>): this {
    this._sort = fields;
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  skip(n: number): this {
    this._skip = n;
    return this;
  }

  async exec(): Promise<T[]> {
    let results = await this.dataFetcher();

    // Sorting
    if (this._sort) {
      const sortKeys = Object.keys(this._sort);
      results.sort((a: any, b: any) => {
        for (let key of sortKeys) {
          const dir = this._sort![key];
          if (a[key] < b[key]) return -1 * dir;
          if (a[key] > b[key]) return 1 * dir;
        }
        return 0;
      });
    }

    // Skip
    if (this._skip > 0) {
      results = results.slice(this._skip);
    }

    // Limit
    if (this._limit !== null) {
      results = results.slice(0, this._limit);
    }

    return results;
  }
}

// ---------- Schema ----------
export class Schema<T> {
  definition: SchemaDefinition<T>;
  constructor(definition: SchemaDefinition<T>) {
    this.definition = definition;
  }
}

// ---------- Model ----------
export class Model<T extends { _id?: string }> {
  private name: string;
  private schema: Schema<T>;
  private redis: Redis;

  constructor(name: string, schema: Schema<T>, redis: Redis) {
    this.name = name;
    this.schema = schema;
    this.redis = redis;
  }

  private _key(id: string) {
    return `${this.name}:${id}`;
  }

  async create(data: Partial<T>): Promise<T> {
    const id = uuidv4();
    const doc: T = { _id: id } as T;

    for (let field in this.schema.definition) {
      (doc as any)[field] = (data as any)[field] ?? null;
    }

    await this.redis.set(this._key(id), JSON.stringify(doc));
    return doc;
  }

  private _matchesQuery(doc: T, query: QueryOperators<T>): boolean {
    return Object.entries(query).every(([field, condition]) => {
      const value = (doc as any)[field];
      if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        for (let op in condition) {
          const operand = (condition as any)[op];
          switch (op) {
            case "$gt": if (!(value > operand)) return false; break;
            case "$gte": if (!(value >= operand)) return false; break;
            case "$lt": if (!(value < operand)) return false; break;
            case "$lte": if (!(value <= operand)) return false; break;
            case "$in": if (!Array.isArray(operand) || !operand.includes(value)) return false; break;
            case "$nin": if (Array.isArray(operand) && operand.includes(value)) return false; break;
            case "$ne": if (value === operand) return false; break;
            default: return false;
          }
        }
        return true;
      }
      return value === condition;
    });
  }

  find(query: QueryOperators<T> = {}): QueryBuilder<T> {
    const fetcher = async () => {
      const keys = await this.redis.keys(`${this.name}:*`);
      const results: T[] = [];
      for (let key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const doc: T = JSON.parse(raw);
        if (this._matchesQuery(doc, query)) {
          results.push(doc);
        }
      }
      return results;
    };
    return new QueryBuilder<T>(fetcher);
  }

  async findOne(query: QueryOperators<T>): Promise<T | null> {
    const results = await this.find(query).limit(1).exec();
    return results.length > 0 ? results[0] : null;
  }

  async findById(id: string): Promise<T | null> {
    const raw = await this.redis.get(this._key(id));
    return raw ? JSON.parse(raw) : null;
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    const key = this._key(id);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    const doc: T = JSON.parse(raw);
    Object.assign(doc, data);
    await this.redis.set(key, JSON.stringify(doc));
    return doc;
  }

  async updateMany(query: QueryOperators<T>, data: Partial<T>): Promise<number> {
    const docs = await this.find(query).exec();
    let count = 0;
    for (let doc of docs) {
      const key = this._key(doc._id!);
      Object.assign(doc, data);
      await this.redis.set(key, JSON.stringify(doc));
      count++;
    }
    return count;
  }

  async delete(id: string): Promise<number> {
    return this.redis.del(this._key(id));
  }

  async deleteMany(query: QueryOperators<T> = {}): Promise<number> {
    const docs = await this.find(query).exec();
    let count = 0;
    for (let doc of docs) {
      await this.redis.del(this._key(doc._id!));
      count++;
    }
    return count;
  }

  async countDocuments(query: QueryOperators<T> = {}): Promise<number> {
    const docs = await this.find(query).exec();
    return docs.length;
  }
}

// ---------- ORM ----------
export class RedisORM {
  private redis: Redis;
  constructor(redisUrl: string = "redis://localhost:6379") {
    this.redis = new Redis(redisUrl);
  }

  model<T extends { _id?: string }>(name: string, schema: Schema<T>): Model<T> {
    return new Model<T>(name, schema, this.redis);
  }
}
