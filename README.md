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

### `connectRedis(url: string)`

Connects to Redis and returns the client instance. Must be called before any model operations.

---
