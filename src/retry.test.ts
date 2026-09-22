import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisModel, RedisError } from "./redis-orm";
import {
  RedisORM,
  resetRedisORMConfig,
  isTransientRedisError,
  isReadCommand,
  isWriteCommand,
} from "./retry";

vi.mock("./redis-client", () => ({
  getRedisClient: vi.fn(() => mockClient),
}));

function transientError(message = "Connection reset by peer") {
  const err = new Error(message) as Error & { code: string };
  err.code = "ECONNRESET";
  return err;
}

function permanentError() {
  const err = new Error("WRONGTYPE Operation against a key holding the wrong kind of value") as Error & {
    code: string;
  };
  err.code = "WRONGTYPE";
  return err;
}

const mockData = new Map<string, string>();

const mockClient = {
  scan: vi.fn(async (_cursor: number, opts: { MATCH: string; COUNT: number }) => {
    const pattern = opts.MATCH.replace("*", "");
    const keys = Array.from(mockData.keys()).filter((k) => k.startsWith(pattern));
    return { cursor: 0, keys };
  }),
  get: vi.fn(async (key: string) => mockData.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    mockData.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    mockData.delete(key);
  }),
};

interface User {
  id?: string;
  name: string;
  age: number;
}

beforeEach(() => {
  mockData.clear();
  vi.clearAllMocks();
  // Restore default implementations: vi.clearAllMocks() only clears call
  // history, while persistent mockRejectedValue() stubs from an earlier
  // test would otherwise leak into the next test.
  mockClient.scan.mockImplementation(async (_cursor: number, opts: { MATCH: string; COUNT: number }) => {
    const pattern = opts.MATCH.replace("*", "");
    const keys = Array.from(mockData.keys()).filter((k) => k.startsWith(pattern));
    return { cursor: 0, keys };
  });
  mockClient.get.mockImplementation(async (key: string) => mockData.get(key) ?? null);
  mockClient.set.mockImplementation(async (key: string, value: string) => {
    mockData.set(key, value);
  });
  mockClient.del.mockImplementation(async (key: string) => {
    mockData.delete(key);
  });
  resetRedisORMConfig();
  // Zero-delay retries so tests stay fast and deterministic.
  RedisORM.configure({
    retry: { retries: 3, backoff: "fixed", delay: 0 },
  });
});

describe("default behavior (retry disabled)", () => {
  it("executes the Redis operation exactly once when no retry is configured", async () => {
    resetRedisORMConfig(); // retries: 0
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });

    expect(mockClient.set).toHaveBeenCalledTimes(1);

    const doc = await UserModel.findById("u1");
    expect(doc?.name).toBe("Alice");
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transient failure when retry is disabled", async () => {
    resetRedisORMConfig();
    mockClient.get.mockRejectedValueOnce(transientError());
    const UserModel = new RedisModel<User>("User");

    await expect(UserModel.findById("u1")).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });
});

describe("retry success", () => {
  it("retries a transient scan failure and succeeds", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.scan
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError());

    const results = await UserModel.find({ age: 25 });
    expect(results).toHaveLength(1);
    // 1 successful create-scan + 2 failed scans + 1 successful scan
    expect(mockClient.scan).toHaveBeenCalledTimes(3);
  });

  it("retries a transient get failure the exact number of times", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.get
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError());

    const doc = await UserModel.findById("u1");
    expect(doc?.name).toBe("Alice");
    expect(mockClient.get).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("retries writes (set) on transient failures", async () => {
    const UserModel = new RedisModel<User>("User");
    mockClient.set
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError());

    const doc = await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    expect(doc.id).toBe("u1");
    expect(mockClient.set).toHaveBeenCalledTimes(3);
    expect(mockData.get("User:u1")).toContain("Alice");
  });
});

describe("retry exhaustion", () => {
  it("rethrows the original error after all retries fail", async () => {
    const UserModel = new RedisModel<User>("User");
    const cause = transientError();
    mockClient.get.mockRejectedValue(cause);

    const err = await UserModel.findById("u1").catch((e) => e);
    expect(err).toBeInstanceOf(RedisError);
    // retries: 3 -> 4 total attempts
    expect(mockClient.get).toHaveBeenCalledTimes(4);
    // Original error preserved as cause (not a RetryError wrapper).
    expect(err.cause).toBe(cause);
    expect(err.name).not.toBe("RetryError");
  });
});

describe("retry policy (transient vs permanent)", () => {
  it("does not retry permanent errors", async () => {
    const UserModel = new RedisModel<User>("User");
    mockClient.get.mockRejectedValue(permanentError());

    await expect(UserModel.findById("u1")).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });

  it("honours a user shouldRetry returning false", async () => {
    const UserModel = new RedisModel<User>("User");
    mockClient.get.mockRejectedValue(transientError());

    await expect(
      UserModel.findById("u1", {
        retry: { retries: 5, delay: 0, shouldRetry: () => false },
      })
    ).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });

  it("classifies error shapes correctly", () => {
    expect(isTransientRedisError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientRedisError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(
      isTransientRedisError(new Error("Connection lost: socket hang up"))
    ).toBe(true);
    expect(
      isTransientRedisError(
        Object.assign(new Error("Connection timeout"), { name: "SocketClosedUnexpectedly" })
      )
    ).toBe(true);
    expect(
      isTransientRedisError(Object.assign(new Error("t"), { name: "TimeoutError" }))
    ).toBe(true);
    expect(
      isTransientRedisError(Object.assign(new Error("x"), { code: "WRONGTYPE" }))
    ).toBe(false);
    expect(
      isTransientRedisError(
        Object.assign(new Error("WRONGPASS invalid username-password"), { code: "WRONGPASS" })
      )
    ).toBe(false);
    expect(
      isTransientRedisError(new DOMException("aborted", "AbortError"))
    ).toBe(false);
    expect(isTransientRedisError(new Error("some random bug"))).toBe(false);
    expect(isTransientRedisError(null)).toBe(false);
  });

  it("classifies read vs write commands", () => {
    expect(isReadCommand("get")).toBe(true);
    expect(isReadCommand("scan")).toBe(true);
    expect(isReadCommand("set")).toBe(false);
    expect(isWriteCommand("set")).toBe(true);
    expect(isWriteCommand("del")).toBe(true);
    expect(isWriteCommand("get")).toBe(false);
  });
});

describe("global configuration", () => {
  it("RedisORM.configure enables retries for all operations", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.get.mockRejectedValueOnce(transientError());
    const doc = await UserModel.findById("u1");
    expect(doc?.name).toBe("Alice");
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });

  it("resetConfig disables retries again", async () => {
    resetRedisORMConfig();
    const UserModel = new RedisModel<User>("User");
    mockClient.get.mockRejectedValueOnce(transientError());

    await expect(UserModel.findById("u1")).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });
});

describe("per-operation override", () => {
  it("per-operation retry wins over the global configuration", async () => {
    // Global: retries 3; operation: retries 1 -> max 2 attempts.
    const UserModel = new RedisModel<User>("User");
    mockClient.get.mockRejectedValue(transientError());

    await expect(
      UserModel.findById("u1", { retry: { retries: 1, delay: 0 } })
    ).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });

  it("per-operation retry can enable retries when globally disabled", async () => {
    resetRedisORMConfig();
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.get.mockRejectedValueOnce(transientError());
    const doc = await UserModel.findById("u1", {
      retry: { retries: 2, delay: 0 },
    });
    expect(doc?.name).toBe("Alice");
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });

  it("per-operation retries: 0 disables a globally enabled retry", async () => {
    const UserModel = new RedisModel<User>("User");
    mockClient.get.mockRejectedValueOnce(transientError());

    await expect(
      UserModel.findById("u1", { retry: { retries: 0 } })
    ).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });

  it("reads: false skips retries for reads, writes: false for writes", async () => {
    const UserModel = new RedisModel<User>("User");

    mockClient.get.mockRejectedValue(transientError());
    await expect(
      UserModel.findById("u1", { retry: { retries: 3, delay: 0, reads: false } })
    ).rejects.toThrow(RedisError);
    expect(mockClient.get).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockClient.set.mockRejectedValue(transientError());
    await expect(
      UserModel.create(
        { id: "u1", name: "Alice", age: 25 },
        { retry: { retries: 3, delay: 0, writes: false } }
      )
    ).rejects.toThrow(RedisError);
    expect(mockClient.set).toHaveBeenCalledTimes(1);
  });

  it("findOneAndUpdate keeps returnNew and supports retry", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.set.mockRejectedValueOnce(transientError());
    const updated = await UserModel.findOneAndUpdate(
      { id: "u1" },
      { age: 26 },
      { returnNew: true, retry: { retries: 2, delay: 0 } }
    );
    expect(updated?.age).toBe(26);
    expect(mockClient.set).toHaveBeenCalledTimes(2);
  });

  it("QueryBuilder.withRetry overrides for a single query", async () => {
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.get.mockRejectedValueOnce(transientError());
    const results = await UserModel.find({ age: 25 })
      .withRetry({ retries: 2, delay: 0 })
      .exec();
    expect(results).toHaveLength(1);
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });
});

describe("hooks / observability", () => {
  it("invokes onRetry, onSuccess and onFailure", async () => {
    const onRetry = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const UserModel = new RedisModel<User>("User");
    await UserModel.create({ id: "u1", name: "Alice", age: 25 });
    vi.clearAllMocks();

    mockClient.get.mockRejectedValueOnce(transientError());
    const doc = await UserModel.findById("u1", {
      retry: { retries: 2, delay: 0, onRetry, onSuccess, onFailure },
    });

    expect(doc?.name).toBe("Alice");
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][1]).toMatchObject({ attempt: 1 });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("invokes onFailure when retries are exhausted", async () => {
    const onFailure = vi.fn();
    const UserModel = new RedisModel<User>("User");
    mockClient.get.mockRejectedValue(transientError());

    await expect(
      UserModel.findById("u1", {
        retry: { retries: 1, delay: 0, onFailure },
      })
    ).rejects.toThrow(RedisError);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe("existing API unchanged", () => {
  it("CRUD + chaining still work without any retry options", async () => {
    resetRedisORMConfig();
    const UserModel = new RedisModel<User>("User");
    const alice = await UserModel.create({ name: "Alice", age: 25 });
    await UserModel.create({ name: "Bob", age: 30 });

    expect(await UserModel.findOne({ id: alice.id })).not.toBeNull();
    expect(await UserModel.findById(alice.id as string)).not.toBeNull();
    expect(await UserModel.find({ age: { $gte: 18 } }).sort({ age: -1 }).limit(10).exec()).toHaveLength(2);
    expect(await UserModel.countDocuments({})).toBe(2);
    expect(await UserModel.updateOne({ id: alice.id }, { age: 26 })).not.toBeNull();
    expect(await UserModel.updateMany({ age: { $gte: 30 } }, { age: 31 })).toBe(1);
    expect(
      await UserModel.findOneAndUpdate({ id: alice.id }, { age: 27 }, { returnNew: true })
    ).not.toBeNull();
    expect(await UserModel.deleteOne({ id: alice.id })).toBe(1);
    expect(await UserModel.findOneAndDelete({ name: "Bob" })).not.toBeNull();
    expect(await UserModel.countDocuments({})).toBe(0);
  });
});
