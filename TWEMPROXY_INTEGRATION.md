# Twemproxy Integration Guide

## Overview

[Twemproxy](https://github.com/twitter/twemproxy) (nutcracker) is a fast and lightweight proxy for Redis that enables horizontal scaling through automatic sharding. This document explains how to use prisma-extension-cache-manager with twemproxy and addresses known limitations.

## Compatibility Issues

### Cache Iteration Not Supported

Twemproxy does **not support** the following Redis commands:
- `KEYS` - Pattern-based key search
- `SCAN` - Iterative key scanning

These commands are essential for the **automatic uncaching** feature, which scans the cache to find and delete all keys related to a model after write operations.

### Impact

When using twemproxy with `useAutoUncache: true`:
- **Read operations**: ✅ Work correctly
- **Write operations**: ✅ Work correctly  
- **Automatic cache invalidation**: ❌ **Does not work** - stale cache entries remain

## Recommended Configuration

### Option 1: Manual Cache Invalidation (Recommended)

Disable automatic uncaching and use manual invalidation strategies:

```typescript
import { PrismaClient } from "@prisma/client";
import { createCache } from "cache-manager";
import cacheExtension from "@paulwer/prisma-extension-cache-manager";

const cache = await createCache({
  // Your twemproxy-backed Redis configuration
  stores: [redisStore],
});

const prisma = new PrismaClient().$extends(
  cacheExtension({ 
    cache, 
    useAutoUncache: false  // Disable auto-uncaching for twemproxy
  })
);

// Manually specify keys to uncache on write operations
await prisma.user.create({
  data: { name: "John" },
  uncache: ["user_list", "user_count"]  // Explicitly list keys to invalidate
});

await prisma.user.update({
  where: { id: 1 },
  data: { name: "Jane" },
  uncache: (result) => [`user-${result.id}`, "user_list"]  // Dynamic uncaching
});
```

### Option 2: Namespace-Based Invalidation

Use consistent namespaces and manually track keys:

```typescript
// Create with namespace
await prisma.user.findMany({
  cache: {
    namespace: "users",
    ttl: 60000
  }
});

// On write, invalidate the entire namespace
await prisma.user.create({
  data: { name: "John" },
  uncache: { namespace: "users", key: "*" }  // Clear namespace
});
```

### Option 3: Key Pattern Convention

Establish a consistent key naming pattern:

```typescript
// Read with predictable keys
await prisma.user.findMany({
  cache: {
    key: "all_users",
    ttl: 60000
  }
});

await prisma.user.findUnique({
  where: { id: 1 },
  cache: {
    key: (result) => `user_${result.id}`,
    ttl: 60000
  }
});

// Write with explicit uncaching
await prisma.user.update({
  where: { id: 1 },
  data: { name: "Updated" },
  uncache: ["all_users", "user_1"]  // Manually specify related keys
});
```

## Alternative: Direct Redis Connection

For applications requiring automatic uncaching, consider connecting cache-manager directly to Redis servers instead of through twemproxy:

```typescript
import { createCache } from "cache-manager";
import { redisStore } from "cache-manager-redis-yet";

// Connect directly to Redis (not through twemproxy)
const cache = await createCache({
  stores: [
    await redisStore({
      socket: {
        host: 'redis-server-1.example.com',
        port: 6379,
      },
    })
  ],
});

const prisma = new PrismaClient().$extends(
  cacheExtension({ 
    cache, 
    useAutoUncache: true  // Now this works!
  })
);
```

## Best Practices

1. **Always set `useAutoUncache: false`** when using twemproxy
2. **Use explicit `uncache` options** on all write operations
3. **Maintain a key registry** in your application code
4. **Use consistent key/namespace patterns** across your application
5. **Consider shorter TTLs** to reduce stale data impact
6. **Test cache invalidation** thoroughly in your integration tests

## Twemproxy Configuration Example

```yaml
alpha:
  listen: 127.0.0.1:22121
  hash: fnv1a_64
  distribution: ketama
  auto_eject_hosts: true
  redis: true
  server_retry_timeout: 2000
  server_failure_limit: 1
  servers:
   - redis-1.example.com:6379:1
   - redis-2.example.com:6379:1
   - redis-3.example.com:6379:1
```

## Additional Resources

- [Twemproxy Documentation](https://github.com/twitter/twemproxy)
- [Twemproxy Redis Command Support](https://github.com/twitter/twemproxy/blob/master/notes/redis.md)
- [Cache-Manager Documentation](https://www.npmjs.com/package/cache-manager)

## Troubleshooting

### Issue: Cache not invalidating
**Solution**: Ensure `useAutoUncache: false` and use explicit `uncache` options.

### Issue: Keys not deleted after write operations
**Solution**: Verify you're specifying the correct keys in the `uncache` parameter.

### Issue: Stale cache entries
**Solution**: Reduce TTL values or implement time-based cache refresh strategies.

## Future Considerations

Potential enhancements for better twemproxy support:
- Explicit key tracking registry
- Pattern-based key generation helpers
- Validation warnings when auto-uncaching is enabled with incompatible stores
