import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisModel, QueryBuilder } from "./redis-orm";

vi.mock("./redis-client", () => ({
  getRedisClient: vi.fn(() => mockClient),
}));

const mockData = new Map<string, string>();

const mockClient = {
  scan: vi.fn(async (cursor: number, opts: { MATCH: string; COUNT: number }) => {
    const pattern = opts.MATCH.replace("*", "");
    const keys = Array.from(mockData.keys()).filter(k => k.startsWith(pattern));
    return { cursor: 0, keys };
  }),
  get: vi.fn(async (key: string) => mockData.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { mockData.set(key, value); }),
  del: vi.fn(async (key: string) => { mockData.delete(key); }),
};

interface User {
  id?: string;
  name: string;
  age: number;
  email?: string;
}

beforeEach(() => {
  mockData.clear();
  vi.clearAllMocks();
});

describe("RedisModel", () => {
  it("creates a document with auto-generated id", async () => {
    const UserModel = new RedisModel<User>("User");
    const doc = await UserModel.create({ name: "Alice", age: 25 });

    expect(doc.id).toBeDefined();
    expect(doc.name).toBe("Alice");
    expect(doc.age).toBe(25);
  });

  it("creates a document with a provided id", async () => {
    const UserModel = new RedisModel<User>("User");
    const doc = await UserModel.create({ id: "abc-123", name: "Bob", age: 30 });

    expect(doc.id).toBe("abc-123");
  });

  it("findById returns null for non-existent id", async () => {
    const UserModel = new RedisModel<User>("User");
    const result = await UserModel.findById("non-existent");
    expect(result).toBeNull();
  });

  it("findById returns the document", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "abc-123", name: "Bob", age: 30 });
    const result = await UserModel.findById("abc-123");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Bob");
  });

  it("find returns all documents matching query", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });
    await UserModel.create({ name: "Charlie", age: 35 });

    const results = await UserModel.find({ age: { $gte: 30 } });
    expect(results).toHaveLength(2);
    expect(results.map(r => r.name)).toEqual(expect.arrayContaining(["Bob", "Charlie"]));
  });

  it("find with $gt operator", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const results = await UserModel.find({ age: { $gt: 25 } });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Bob");
  });

  it("find with $lt operator", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const results = await UserModel.find({ age: { $lt: 30 } });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice");
  });

  it("find with $in operator", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });
    await UserModel.create({ name: "Charlie", age: 35 });

    const results = await UserModel.find({ age: { $in: [25, 35] } });
    expect(results).toHaveLength(2);
  });

  it("find with $nin operator", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const results = await UserModel.find({ age: { $nin: [25] } });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Bob");
  });

  it("find with $ne operator", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const results = await UserModel.find({ age: { $ne: 25 } });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Bob");
  });

  it("findOne returns first match", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 25 });

    const result = await UserModel.findOne({ age: 25 });
    expect(result).not.toBeNull();
    expect(result!.age).toBe(25);
  });

  it("findOne returns null when no match", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });

    const result = await UserModel.findOne({ age: 99 });
    expect(result).toBeNull();
  });

  it("updateMany updates matching documents", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const count = await UserModel.updateMany({ age: { $gte: 30 } }, { age: 31 });
    expect(count).toBe(1);

    const bob = await UserModel.findById("Bob") as any;
    expect(bob).toBeDefined();
  });

  it("updateOne updates a single document", async () => {
    const UserModel = new RedisModel<User>("User");
    const alice = await UserModel.create({ name: "Alice", age: 25 });

    const updated = await UserModel.updateOne({ id: alice.id }, { age: 26 });
    expect(updated).not.toBeNull();
    expect(updated!.age).toBe(26);
  });

  it("deleteMany removes matching documents", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const count = await UserModel.deleteMany({ age: { $gte: 30 } });
    expect(count).toBe(1);

    const all = await UserModel.find({});
    expect(all).toHaveLength(1);
  });

  it("deleteOne removes a single document", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });

    const count = await UserModel.deleteOne({ name: "Alice" });
    expect(count).toBe(1);

    const all = await UserModel.find({});
    expect(all).toHaveLength(0);
  });

  it("countDocuments returns correct count", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const count = await UserModel.countDocuments({ age: { $gte: 25 } });
    expect(count).toBe(2);
  });
});

describe("QueryBuilder chaining", () => {
  it("supports sort, skip, limit, exec", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });
    await UserModel.create({ name: "Charlie", age: 35 });

    const results = await UserModel.find({})
      .sort({ age: -1 })
      .skip(1)
      .limit(1)
      .exec();

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Bob");
  });

  it("is thenable (works with await)", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });

    const results = await UserModel.find({});
    expect(results).toHaveLength(1);
  });

  it("sort ascending works", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Charlie", age: 35 });
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    const results = await UserModel.find({}).sort({ age: 1 }).exec();
    expect(results.map(r => r.name)).toEqual(["Alice", "Bob", "Charlie"]);
  });
});

describe("QueryBuilder with sort and null values", () => {
  it("handles null field values in sort", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30, email: "b@b.com" });

    const results = await UserModel.find({}).sort({ email: -1 }).exec();
    expect(results).toHaveLength(2);
  });
});
