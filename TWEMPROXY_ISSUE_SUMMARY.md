# Twemproxy Integration Issue Summary

## Issue Title
Prisma Extension Cache Manager Integration with Twemproxy for Cache Invalidation

## Background

The **prisma-extension-cache-manager** library (https://github.com/Delgerskhn/prisma-extension-cache-manager) is a Prisma ORM caching extension that uses cache-manager to provide automatic cache invalidation for write operations. When integrated with Twemproxy as a Redis proxy, cache invalidation fails silently while read operations work correctly.

## Root Cause Analysis

### Twemproxy Limitations

Twemproxy does not support the following Redis commands that are required for iterator-based cache invalidation:
- `SCAN` - Iterative key scanning
- `KEYS` - Pattern-based key search

Reference: https://github.com/twitter/twemproxy/blob/master/notes/redis.md (lines 18, 48)

### Impact on Cache Invalidation

The prisma-extension-cache-manager library's automatic uncaching feature relies on:
1. Iterating over all cache keys using `SCAN` (via cache-manager's iterator interface)
2. Finding keys matching a specific model pattern (e.g., `:User:`)
3. Deleting matching keys to invalidate stale cache

**Code Location**: `src/index.ts`, lines 226-244 (processAutoUncache function)

```typescript
const processAutoUncache = async () => {
  const keysToDelete: string[] = [];
  const models = getInvolvedModels(Prisma, model, operation, args);

  await Promise.all(
    models.map((model) =>
      (async () => {
        for (const store of cache.stores)
          if (store?.iterator) {
            for await (const [key] of store.iterator({})) {
              if (key.includes(`:${model}:`)) keysToDelete.push(key);
            }
          }
      })(),
    ),
  );

  await safeDelete(keysToDelete);
};
```

Without `SCAN` support, the iterator returns no keys, resulting in:
- ✅ Read operations work (GET, SET commands are supported)
- ✅ Write operations work (queries execute successfully)
- ❌ Cache invalidation fails silently (stale data remains cached)

## Solution Implemented

Since Twemproxy's proxy architecture fundamentally cannot support `SCAN` across sharded servers, we implemented a documentation-based solution:

### 1. Comprehensive Integration Guide
Created `TWEMPROXY_INTEGRATION.md` with:
- Explanation of the limitation
- Manual cache invalidation strategies
- Best practices for Twemproxy users
- Alternative configurations

### 2. Runtime Warning System
Added validation in `src/index.ts` that detects when:
- `useAutoUncache: true` is set
- No cache store supports iteration
- Logs clear warning with remediation steps

### 3. Manual Cache Invalidation Support
Documented three approaches:

**Option 1: Explicit key uncaching**
```typescript
await prisma.user.update({
  where: { id: 1 },
  data: { name: "Updated" },
  uncache: ["user_list", "user_count", "user_1"]
});
```

**Option 2: Function-based uncaching**
```typescript
await prisma.user.update({
  where: { id: 1 },
  data: { name: "Updated" },
  uncache: (result) => [`user_${result.id}`, "all_users"]
});
```

**Option 3: Namespace-based invalidation**
```typescript
await prisma.user.findMany({
  cache: { namespace: "users", ttl: 60000 }
});

await prisma.user.create({
  data: { ... },
  uncache: [{ namespace: "users", key: "list" }]
});
```

### 4. Test Coverage
Created `test/twemproxy.test.ts` with:
- Mock store simulating Twemproxy behavior (no iterator)
- Tests validating manual uncaching works correctly
- Demonstration of auto-uncaching limitation
- Warning detection tests

## Recommendations for Twemproxy Users

1. **Always set `useAutoUncache: false`** when using Twemproxy
2. **Use explicit `uncache` options** on all write operations
3. **Maintain consistent key/namespace patterns** for easier invalidation
4. **Consider shorter TTLs** to reduce stale data impact
5. **Implement application-level key tracking** if needed

## Alternative: Direct Redis Connection

For applications requiring automatic uncaching, connect cache-manager directly to Redis servers instead of through Twemproxy:

```typescript
// Instead of: Twemproxy → Redis cluster
// Use: cache-manager → Redis directly

const cache = await createCache({
  stores: [
    await redisStore({
      socket: { host: 'redis-1.example.com', port: 6379 }
    })
  ]
});

const prisma = new PrismaClient().$extends(
  cacheExtension({ cache, useAutoUncache: true }) // Now works!
);
```

## Related Issues/PRs

- **Repository**: https://github.com/Delgerskhn/prisma-extension-cache-manager
- **PR**: [Add Twemproxy Integration Support and Documentation](#)
- **Files Changed**:
  - `TWEMPROXY_INTEGRATION.md` (new)
  - `README.md` (updated)
  - `src/index.ts` (runtime validation)
  - `src/types.ts` (documentation)
  - `test/twemproxy.test.ts` (new)

## Testing

All tests pass:
```
✔ Twemproxy compatibility (64.974378ms)
  ✔ should warn when useAutoUncache is true with non-iterator store
  ✔ should NOT warn when useAutoUncache is false
  ✔ manual uncaching should work without iterator support
  ✔ manual uncaching with function should work
  ✔ manual uncaching with namespace should work
  ✔ automatic uncaching should NOT work without iterator (expected behavior)
```

## Security

CodeQL scan completed with 0 vulnerabilities found.

## Conclusion

This integration demonstrates a working solution for using prisma-extension-cache-manager with Twemproxy. While automatic cache invalidation is not possible due to Twemproxy's architectural design, manual invalidation strategies provide a robust alternative. The implementation includes:

- ✅ Clear documentation of limitations
- ✅ Runtime warnings for misconfiguration
- ✅ Multiple manual invalidation strategies
- ✅ Comprehensive test coverage
- ✅ Security validation
- ✅ Zero breaking changes

Users can now confidently deploy this library with Twemproxy by following the documented best practices.

---

**For Twemproxy maintainers**: This issue serves as documentation of the integration and its limitations. No changes to Twemproxy are requested or expected, as supporting `SCAN` across sharded servers would require fundamental architectural changes that may not align with Twemproxy's design goals.
