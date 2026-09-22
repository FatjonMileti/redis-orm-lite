# Redis ORM Lite

A lightweight **Redis ORM** for Node.js with a **Mongoose-like API**.

- `.create()` — create a document
- `.find()` / `.findOne()` / `.findById()` — query documents
- `.updateOne()` / `.updateMany()` — update documents
- `.deleteOne()` / `.deleteMany()` — delete documents
- `.findOneAndUpdate()` / `.findOneAndDelete()` — find-then-modify
- `.countDocuments()` — count matching documents
- Query chaining: `.sort()`, `.skip()`, `.limit()`, `.exec()`

---

## Requirements

- Node.js ≥ 16
- A running Redis server (local, Docker, or cloud)
- TypeScript ≥ 5 (recommended, but not required for consumers)

---

## Installation

```bash
npm install redis-orm-lite
```

---

## Usage

```ts
import { RedisModel, connectRedis, RedisError } from "redis-orm-lite";

interface User {
  id?: string;
  name: string;
  email: string;
  age: number;
}

// Connect to Redis
await connectRedis("redis://localhost:6379");

// Create model
const UserModel = new RedisModel<User>("User");

// Create documents
const alice = await UserModel.create({
  name: "Alice",
  email: "a@mail.com",
  age: 25,
});
await UserModel.create({ name: "Bob", email: "b@mail.com", age: 30 });
await UserModel.create({ name: "Charlie", email: "c@mail.com", age: 40 });

// Find with query + chaining
const adults = await UserModel.find({ age: { $gte: 18 } })
  .sort({ age: -1 })
  .skip(0)
  .limit(10)
  .exec();

// find() is thenable — works with await directly too:
const allUsers = await UserModel.find({});

// Find one
const firstAdult = await UserModel.findOne({ age: { $gte: 18 } });

// Find by ID
if (alice.id) {
  const userById = await UserModel.findById(alice.id);
}

// Count documents
const count = await UserModel.countDocuments({ age: { $gte: 18 } });

// Update one
const updated = await UserModel.updateOne({ id: alice.id }, { age: 26 });

// Update many
await UserModel.updateMany({ age: { $lt: 25 } }, { age: 25 });

// Delete
await UserModel.deleteOne({ id: alice.id });
await UserModel.deleteMany({ age: { $gte: 100 } });

// Find one and update (returns updated doc if returnNew: true)
await UserModel.findOneAndUpdate(
  { email: "b@mail.com" },
  { age: 35 },
  { returnNew: true }
);

// Find one and delete
await UserModel.findOneAndDelete({ age: { $gte: 35 } });
```

---

## Query Operators

| Operator | Meaning |
|----------|---------|
| `$gt`    | greater than |
| `$gte`   | greater than or equal |
| `$lt`    | less than |
| `$lte`   | less than or equal |
| `$in`    | value in array |
| `$nin`   | value not in array |
| `$ne`    | not equal |

---

## Chaining API

`find()` returns a `QueryBuilder` that supports:

```ts
const results = await UserModel.find({ age: { $gte: 21 } })
  .sort({ age: -1, name: 1 })   // sort by age desc, then name asc
  .skip(5)                       // skip first 5 results
  .limit(20)                     // limit to 20 results
  .exec();                       // execute the query
```

`QueryBuilder` is also **thenable**, so you can `await` it directly:

```ts
const results = await UserModel.find({ age: { $gte: 21 } });
```

---

## Error Handling

All Redis operations throw `RedisError` on failure:

```ts
import { RedisModel, connectRedis, RedisError } from "redis-orm-lite";

try {
  const user = await UserModel.create({ name: "Alice", age: 25 });
} catch (err) {
  if (err instanceof RedisError) {
    console.error("Redis operation failed:", err.message, err.cause);
  }
}
```

---

## API Reference

### `RedisModel<T>`

| Method | Returns | Description |
|--------|---------|-------------|
| `create(doc)` | `Promise<T>` | Create a document (auto-generates `id` if missing) |
| `find(query)` | `QueryBuilder<T>` | Build a query with chaining |
| `findOne(query)` | `Promise<T \| null>` | Return first match or null |
| `findById(id)` | `Promise<T \| null>` | Fetch by primary key |
| `updateMany(query, update)` | `Promise<number>` | Update matching documents, returns count |
| `updateOne(query, update)` | `Promise<T \| null>` | Update first match, returns updated doc |
| `findOneAndUpdate(query, update, opts?)` | `Promise<T \| null>` | Update and return (old or new based on `returnNew`) |
| `deleteMany(query)` | `Promise<number>` | Delete matching documents, returns count |
| `deleteOne(query)` | `Promise<number>` | Delete first match, returns 1 or 0 |
| `findOneAndDelete(query)` | `Promise<T \| null>` | Delete first match, returns deleted doc |
| `countDocuments(query)` | `Promise<number>` | Count matching documents |

### `QueryBuilder<T>`

| Method | Returns | Description |
|--------|---------|-------------|
| `sort(config)` | `QueryBuilder<T>` | Sort by fields (`{ field: 1 \| -1 }`) |
| `skip(n)` | `QueryBuilder<T>` | Skip n results |
| `limit(n)` | `QueryBuilder<T>` | Limit to n results |
| `exec()` | `Promise<T[]>` | Execute the query |
| *(thenable)* | `Promise<T[]>` | Can be used with `await` directly |

### `connectRedis(url: string, options?: ConnectRedisOptions)`

Connects to Redis and returns the client instance. Must be called before any model operations.

`options.retry` optionally sets the global retry policy (see below).

---

## Retry configuration

Transient Redis failures (dropped connections, network blips, timeouts) can
be retried automatically via [`node-retry-kit`](https://www.npmjs.com/package/node-retry-kit),
a runtime dependency of this package. The retry engine (backoff, jitter,
timeout, `AbortSignal`) lives in `node-retry-kit`; `redis-orm-lite` only adds
the Redis-specific policy: error classification, read/write gating, and ORM
integration through a single centralized `executeRedisCommand` layer.

**Retry is optional and disabled by default** (`retries: 0`). Upgrading does
not change existing behavior: every Redis command still executes exactly once
unless you explicitly configure retries. Enabling retries adds latency on
failure (waits between attempts), so opt in deliberately.

### Global configuration

```ts
import { RedisORM } from "redis-orm-lite";

RedisORM.configure({
  retry: {
    retries: 3,
    backoff: "exponential",
    delay: 100,
    maxDelay: 2000,
    jitter: true,
  },
});
```

or equivalently at connect time:

```ts
await connectRedis("redis://localhost:6379", {
  retry: { retries: 3, backoff: "exponential", delay: 100, maxDelay: 2000, jitter: true },
});
```

All options (`retries`, `backoff`, `delay`, `maxDelay`, `jitter`, `timeout`,
`signal`, `shouldRetry`, `onRetry`, `onSuccess`, `onFailure`) follow the
`node-retry-kit` semantics (`retries: 3` = up to 4 total attempts).
`RedisORM.getConfig()` reads the current config; `RedisORM.resetConfig()`
restores defaults (retry disabled).

### Per-operation configuration

Any model method accepts an optional trailing `{ retry, signal }` argument
that is merged over (wins against) the global configuration:

```ts
await UserModel.findOne({ id: "123" }, { retry: { retries: 5, delay: 100 } });

// Retry disabled for one sensitive call even though globally enabled:
await UserModel.findById("123", { retry: { retries: 0 } });

// QueryBuilder alternative:
await UserModel.find({ age: { $gte: 18 } }).withRetry({ retries: 2 }).exec();
```

`findOneAndUpdate` already takes an options argument, so retry options were
added to it without breaking its signature:

```ts
await UserModel.findOneAndUpdate({ id: "123" }, { age: 26 }, { returnNew: true });
await UserModel.findOneAndUpdate(
  { id: "123" },
  { age: 26 },
  { returnNew: true, retry: { retries: 5 } }
);
```

### Which errors are retried

Only **transient** errors are retried (see `isTransientRedisError`):

- network / connection failures (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`,
  socket closed/hang-up, `ENOTFOUND`, `EAI_AGAIN`, …),
- timeouts (including `node-retry-kit` per-attempt `TimeoutError`s),
- momentary server conditions (`LOADING`, `TRYAGAIN`, `BUSY`, `CLUSTERDOWN`).

**Never retried:** authentication / permission errors (`WRONGPASS`, `NOAUTH`,
`NOPERM`), unknown commands, wrong argument counts, `WRONGTYPE` and other
data errors, and `AbortError` cancellations. A custom `shouldRetry(error,
context)` predicate can narrow the policy further, but it cannot widen it to
permanent errors.

### Write-operation safety and idempotency

Every write this ORM performs is a whole-document overwrite
(`SET key <full JSON>`) or a key deletion (`DEL`) — both idempotent, so a
retry after an ambiguous failure cannot corrupt data the way retrying e.g.
`INCR` could. If the final attempt fails, the **original error is rethrown**
(via `RedisError.cause`); errors are never wrapped in `RetryError`.

If you need stricter control, gate retries by command class:

```ts
RedisORM.configure({
  retry: { retries: 3, delay: 100, reads: true, writes: false },
});
```

`reads` covers `SCAN`/`GET`, `writes` covers `SET`/`DEL` (both default to
`true`).

### Observability

The library never logs on its own. Observe retries through hooks:

```ts
RedisORM.configure({
  retry: {
    retries: 3,
    onRetry(error, context) {
      console.warn("Redis operation retry", {
        attempt: context.attempt,
        delay: context.delay,
        error,
      });
    },
    onFailure(error, context) {
      console.error("Redis operation failed", error);
    },
  },
});
```

### Cancellation

Pass an `AbortSignal` globally (`retry.signal`), per operation (`{ signal }`),
or per attempt via `timeout`. Aborting stops further retries and never leaves
retry timers running. Limitation: node-redis v4 commands do not accept a
signal, so an already in-flight command still runs to completion — only the
retry loop/waits are cancelled. Connection management itself stays with the
Redis client; retries never trigger manual reconnects.

---
