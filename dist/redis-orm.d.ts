import Redis from "ioredis";
type SchemaDefinition<T> = {
    [K in keyof T]: any;
};
type QueryOperators<T> = {
    [K in keyof T]?: T[K] | {
        $gt?: T[K];
        $gte?: T[K];
        $lt?: T[K];
        $lte?: T[K];
        $in?: T[K][];
        $nin?: T[K][];
        $ne?: T[K];
    };
};
declare class QueryBuilder<T> {
    private dataFetcher;
    private _sort;
    private _limit;
    private _skip;
    constructor(dataFetcher: () => Promise<T[]>);
    sort(fields: Record<string, 1 | -1>): this;
    limit(n: number): this;
    skip(n: number): this;
    exec(): Promise<T[]>;
}
export declare class Schema<T> {
    definition: SchemaDefinition<T>;
    constructor(definition: SchemaDefinition<T>);
}
export declare class Model<T extends {
    _id?: string;
}> {
    private name;
    private schema;
    private redis;
    constructor(name: string, schema: Schema<T>, redis: Redis);
    private _key;
    create(data: Partial<T>): Promise<T>;
    private _matchesQuery;
    find(query?: QueryOperators<T>): QueryBuilder<T>;
    findOne(query: QueryOperators<T>): Promise<T | null>;
    findById(id: string): Promise<T | null>;
    update(id: string, data: Partial<T>): Promise<T | null>;
    updateMany(query: QueryOperators<T>, data: Partial<T>): Promise<number>;
    delete(id: string): Promise<number>;
    deleteMany(query?: QueryOperators<T>): Promise<number>;
    countDocuments(query?: QueryOperators<T>): Promise<number>;
}
export declare class RedisORM {
    private redis;
    constructor(redisUrl?: string);
    model<T extends {
        _id?: string;
    }>(name: string, schema: Schema<T>): Model<T>;
}
export {};
