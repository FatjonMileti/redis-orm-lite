"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisORM = exports.Model = exports.Schema = void 0;
// redis-orm.ts
const ioredis_1 = __importDefault(require("ioredis"));
const uuid_1 = require("uuid");
// ---------- Query Builder ----------
class QueryBuilder {
    constructor(dataFetcher) {
        this._sort = null;
        this._limit = null;
        this._skip = 0;
        this.dataFetcher = dataFetcher;
    }
    sort(fields) {
        this._sort = fields;
        return this;
    }
    limit(n) {
        this._limit = n;
        return this;
    }
    skip(n) {
        this._skip = n;
        return this;
    }
    async exec() {
        let results = await this.dataFetcher();
        // Sorting
        if (this._sort) {
            const sortKeys = Object.keys(this._sort);
            results.sort((a, b) => {
                for (let key of sortKeys) {
                    const dir = this._sort[key];
                    if (a[key] < b[key])
                        return -1 * dir;
                    if (a[key] > b[key])
                        return 1 * dir;
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
class Schema {
    constructor(definition) {
        this.definition = definition;
    }
}
exports.Schema = Schema;
// ---------- Model ----------
class Model {
    constructor(name, schema, redis) {
        this.name = name;
        this.schema = schema;
        this.redis = redis;
    }
    _key(id) {
        return `${this.name}:${id}`;
    }
    async create(data) {
        var _a;
        const id = (0, uuid_1.v4)();
        const doc = { _id: id };
        for (let field in this.schema.definition) {
            doc[field] = (_a = data[field]) !== null && _a !== void 0 ? _a : null;
        }
        await this.redis.set(this._key(id), JSON.stringify(doc));
        return doc;
    }
    _matchesQuery(doc, query) {
        return Object.entries(query).every(([field, condition]) => {
            const value = doc[field];
            if (condition && typeof condition === "object" && !Array.isArray(condition)) {
                for (let op in condition) {
                    const operand = condition[op];
                    switch (op) {
                        case "$gt":
                            if (!(value > operand))
                                return false;
                            break;
                        case "$gte":
                            if (!(value >= operand))
                                return false;
                            break;
                        case "$lt":
                            if (!(value < operand))
                                return false;
                            break;
                        case "$lte":
                            if (!(value <= operand))
                                return false;
                            break;
                        case "$in":
                            if (!Array.isArray(operand) || !operand.includes(value))
                                return false;
                            break;
                        case "$nin":
                            if (Array.isArray(operand) && operand.includes(value))
                                return false;
                            break;
                        case "$ne":
                            if (value === operand)
                                return false;
                            break;
                        default: return false;
                    }
                }
                return true;
            }
            return value === condition;
        });
    }
    find(query = {}) {
        const fetcher = async () => {
            const keys = await this.redis.keys(`${this.name}:*`);
            const results = [];
            for (let key of keys) {
                const raw = await this.redis.get(key);
                if (!raw)
                    continue;
                const doc = JSON.parse(raw);
                if (this._matchesQuery(doc, query)) {
                    results.push(doc);
                }
            }
            return results;
        };
        return new QueryBuilder(fetcher);
    }
    async findOne(query) {
        const results = await this.find(query).limit(1).exec();
        return results.length > 0 ? results[0] : null;
    }
    async findById(id) {
        const raw = await this.redis.get(this._key(id));
        return raw ? JSON.parse(raw) : null;
    }
    async update(id, data) {
        const key = this._key(id);
        const raw = await this.redis.get(key);
        if (!raw)
            return null;
        const doc = JSON.parse(raw);
        Object.assign(doc, data);
        await this.redis.set(key, JSON.stringify(doc));
        return doc;
    }
    async updateMany(query, data) {
        const docs = await this.find(query).exec();
        let count = 0;
        for (let doc of docs) {
            const key = this._key(doc._id);
            Object.assign(doc, data);
            await this.redis.set(key, JSON.stringify(doc));
            count++;
        }
        return count;
    }
    async delete(id) {
        return this.redis.del(this._key(id));
    }
    async deleteMany(query = {}) {
        const docs = await this.find(query).exec();
        let count = 0;
        for (let doc of docs) {
            await this.redis.del(this._key(doc._id));
            count++;
        }
        return count;
    }
    async countDocuments(query = {}) {
        const docs = await this.find(query).exec();
        return docs.length;
    }
}
exports.Model = Model;
// ---------- ORM ----------
class RedisORM {
    constructor(redisUrl = "redis://localhost:6379") {
        this.redis = new ioredis_1.default(redisUrl);
    }
    model(name, schema) {
        return new Model(name, schema, this.redis);
    }
}
exports.RedisORM = RedisORM;
