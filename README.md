# Redis ORM Lite

A lightweight **Redis ORM** for Node.js with a **Mongoose-like API**.  
Supports:

- `.create()`
- `.find()`
- `.findOne()`
- `.findById()`
- `.updateOne()`
- `.updateMany()`
- `.deleteOne()`
- `.deleteMany()`
- `.findOneAndUpdate()`
- `.findOneAndDelete()`
- `.countDocuments()`
- Query chaining: `.sort()`, `.skip()`, `.limit()`, `.exec()`

---

## 📦 Requirements

- Node.js ≥ 16
- A running Redis server (local, Docker, or cloud)
- TypeScript ≥ 5 (recommended)

---

## ⚡ Installation

### 1. From npm (if published)

```bash
npm install redis-orm-lite

```

### 2. Local installation (without publishing)

```bash
# From your CRUD app
npm install ../path-to/redis-orm-lite

```

### Or using npm link for live development:

```bash
cd ../path-to/redis-orm-lite
npm link

cd ../crud-app
npm link redis-orm-lite

```

## 📖 Usage Example

```ts
import { RedisModel, connectRedis } from "redis-orm-lite";

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

(async () => {
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

  console.log("Adults:", adults);

  // Find one
  const firstAdult = await UserModel.findOne({ age: { $gte: 18 } });
  console.log("First adult:", firstAdult);

  // Find by ID
  if (alice.id) {
    const userById = await UserModel.findById(alice.id);
    console.log("Find by ID:", userById);
  }

  // Count documents
  const count = await UserModel.countDocuments({ age: { $gte: 18 } });
  console.log("Adult count:", count);

  // Update one
  const updatedOne = await UserModel.updateOne({ id: alice.id }, { age: 26 });
  console.log("Updated one:", updatedOne);

  // Update many
  const updatedMany = await UserModel.updateMany(
    { age: { $lt: 25 } },
    { age: 25 }
  );
  console.log("Updated many:", updatedMany);

  // Delete one
  const deletedOne = await UserModel.deleteOne({ id: alice.id });
  console.log("Deleted one:", deletedOne);

  // Delete many
  const deletedMany = await UserModel.deleteMany({ age: { $gte: 100 } });
  console.log("Deleted many:", deletedMany);

  // Find one and update (returns updated doc if returnNew: true)
  const findUpdate = await UserModel.findOneAndUpdate(
    { email: "b@mail.com" },
    { age: 35 },
    { returnNew: true }
  );
  console.log("Find and update:", findUpdate);

  // Find one and delete
  const findDelete = await UserModel.findOneAndDelete({ age: { $gte: 35 } });
  console.log("Find and delete:", findDelete);
})();
```

## 🔑 Supported Query Operators

- `$gt` → greater than
- `$gte` → greater than or equal
- `$lt` → less than
- `$lte` → less than or equal
- `$in` → value in array
- `$nin` → value not in array
- `$ne` → not equal

```

```

## 🛠 Features

- **Mongoose-like API over Redis**
  - `.create()`, `.find()`, `.findOne()`, `.findById()`
  - `.updateMany()`, `.updateOne()`
  - `.deleteMany(), `.deleteOne()`
  - `.countDocuments()`
- **Query chaining**
  - `.sort({ field: 1 | -1 })`
  - `.skip(n)`
  - `.limit(n)`
  - `.exec()`
- **UUID-based `_id` fields**
- **Works with any Redis deployment** (local, Docker, or cloud)
