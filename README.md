# Redis ORM Lite

A lightweight **Redis ORM** for Node.js with a **Mongoose-like API**.  
Supports `.find()`, `.findOne()`, `.findById()`, `.updateMany()`, `.deleteMany()`, `.countDocuments()` and query chaining with `.sort()`, `.skip()`, `.limit()`, `.exec()`.

---

## 📦 Requirements
- Node.js ≥ 16  
- A running Redis server (local, Docker, or cloud)  
- TypeScript ≥ 5 (recommended)

---

## ⚡ Installation

```bash
npm install redis-orm-lite
```

## 📖 Usage Example

```ts
import { Schema, RedisORM } from "redis-orm-lite";

interface User {
  _id?: string;
  name: string;
  email: string;
  age: number;
}

// Connect to Redis (pass a URL or omit to use default localhost)
const orm = new RedisORM("redis://localhost:6379");

// Define schema
const userSchema = new Schema<User>({
  name: String,
  email: String,
  age: Number
});

// Create model
const UserModel = orm.model<User>("User", userSchema);

(async () => {
  // Create documents
  const alice = await UserModel.create({ name: "Alice", email: "a@mail.com", age: 25 });
  await UserModel.create({ name: "Bob", email: "b@mail.com", age: 30 });
  await UserModel.create({ name: "Charlie", email: "c@mail.com", age: 40 });

  // Find with query + chaining
  const adults = await UserModel.find({ age: { $gte: 18 } })
    .sort({ age: -1 })   // Sort by age descending
    .skip(0)             // Pagination skip
    .limit(10)           // Limit to 10 results
    .exec();

  console.log("Adults:", adults);

  // Find one
  const firstAdult = await UserModel.findOne({ age: { $gte: 18 } });
  console.log("First adult:", firstAdult);

  // Find by ID
  if (alice._id) {
    const userById = await UserModel.findById(alice._id);
    console.log("Find by ID:", userById);
  }

  // Count
  const count = await UserModel.countDocuments({ age: { $gte: 18 } });
  console.log("Adult count:", count);

  // Update many
  const updated = await UserModel.updateMany({ age: { $lt: 25 } }, { age: 25 });
  console.log("Updated docs:", updated);

  // Delete many
  const removed = await UserModel.deleteMany({ age: { $gte: 100 } });
  console.log("Deleted docs:", removed);
})();

```

## 🔑 Supported Query Operators

- `$gt`  → greater than  
- `$gte` → greater than or equal  
- `$lt`  → less than  
- `$lte` → less than or equal  
- `$in`  → value in array  
- `$nin` → value not in array  
- `$ne`  → not equal

```

```
## 🛠 Features

- **Mongoose-like API over Redis**
  - `.create()`, `.find()`, `.findOne()`, `.findById()`
  - `.updateMany()`, `.deleteMany()`
  - `.countDocuments()`
- **Query chaining**
  - `.sort({ field: 1 | -1 })`
  - `.skip(n)`
  - `.limit(n)`
  - `.exec()`
- **UUID-based `_id` fields**
- **Works with any Redis deployment** (local, Docker, or cloud)

