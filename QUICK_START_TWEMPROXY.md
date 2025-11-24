# Quick Start: Using prisma-extension-cache-manager with Twemproxy

This is a quick reference guide for using this library with Twemproxy. For detailed information, see [TWEMPROXY_INTEGRATION.md](./TWEMPROXY_INTEGRATION.md).

## The Key Issue

**Twemproxy doesn't support automatic cache invalidation** because it doesn't support Redis `SCAN` commands. You must use manual cache invalidation.

## Setup (3 Steps)

### 1. Configure the Extension

```typescript
import { PrismaClient } from "@prisma/client";
import { createCache } from "cache-manager";
import { redisStore } from "cache-manager-redis-yet";
import cacheExtension from "@paulwer/prisma-extension-cache-manager";

const cache = await createCache({
  stores: [
    await redisStore({
      socket: {
        host: 'localhost',  // Your Twemproxy address
        port: 22121,        // Your Twemproxy port
      },
    })
  ],
});

const prisma = new PrismaClient().$extends(
  cacheExtension({ 
    cache, 
    useAutoUncache: false  // ⚠️ MUST be false for Twemproxy!
  })
);
```

### 2. Use Consistent Cache Keys

Always use explicit keys for caching:

```typescript
// ✅ Good - explicit key
await prisma.user.findMany({
  cache: {
    key: "all_users",
    ttl: 60000
  }
});

// ✅ Good - dynamic key with function
await prisma.user.findUnique({
  where: { id: 1 },
  cache: {
    key: (result) => `user_${result.id}`,
    ttl: 60000
  }
});

// ❌ Bad - auto-generated keys are hard to invalidate
await prisma.user.findMany({ cache: true });
```

### 3. Manually Invalidate on Writes

Specify which keys to delete on write operations:

```typescript
// Update with explicit uncaching
await prisma.user.update({
  where: { id: 1 },
  data: { name: "Updated Name" },
  uncache: ["all_users", "user_1"]  // Delete these keys
});

// Create with dynamic uncaching
await prisma.user.create({
  data: { name: "New User" },
  uncache: (result) => [`user_${result.id}`, "all_users"]
});

// Delete with namespace uncaching
await prisma.user.delete({
  where: { id: 1 },
  uncache: [
    { namespace: "users", key: "list" },
    { namespace: "users", key: "count" }
  ]
});
```

## Complete Example

```typescript
import { PrismaClient } from "@prisma/client";
import { createCache } from "cache-manager";
import { redisStore } from "cache-manager-redis-yet";
import cacheExtension from "@paulwer/prisma-extension-cache-manager";

async function main() {
  // Setup cache pointing to Twemproxy
  const cache = await createCache({
    stores: [
      await redisStore({
        socket: { host: 'localhost', port: 22121 }
      })
    ],
  });

  // Initialize Prisma with cache extension
  const prisma = new PrismaClient().$extends(
    cacheExtension({ 
      cache, 
      useAutoUncache: false  // Required for Twemproxy
    })
  );

  // Read with caching
  const users = await prisma.user.findMany({
    cache: {
      key: "all_users",
      ttl: 60000
    }
  });

  const user = await prisma.user.findUnique({
    where: { id: 1 },
    cache: {
      key: "user_1",
      ttl: 60000
    }
  });

  // Write with manual cache invalidation
  await prisma.user.update({
    where: { id: 1 },
    data: { name: "Updated" },
    uncache: ["all_users", "user_1"]  // Invalidate related caches
  });

  // Create with dynamic invalidation
  const newUser = await prisma.user.create({
    data: {
      email: "user@example.com",
      name: "New User"
    },
    uncache: (result) => [
      `user_${result.id}`,
      "all_users"
    ]
  });
}

main().catch(console.error);
```

## Key Patterns

### Pattern 1: List + Individual Items
```typescript
// Cache list
await prisma.user.findMany({ cache: { key: "user_list" } });

// Cache individual items
await prisma.user.findUnique({
  where: { id: 1 },
  cache: { key: "user_1" }
});

// Invalidate both on update
await prisma.user.update({
  where: { id: 1 },
  data: { name: "Updated" },
  uncache: ["user_list", "user_1"]
});
```

### Pattern 2: Namespace Organization
```typescript
// Group related caches
await prisma.user.findMany({
  cache: { namespace: "users", key: "active" }
});

await prisma.user.count({
  cache: { namespace: "users", key: "count" }
});

// Invalidate by namespace
await prisma.user.create({
  data: { name: "New" },
  uncache: [
    { namespace: "users", key: "active" },
    { namespace: "users", key: "count" }
  ]
});
```

### Pattern 3: Function-Based Invalidation
```typescript
// Write operation that knows what to invalidate
await prisma.user.update({
  where: { id: userId },
  data: { status: "active" },
  uncache: (result) => {
    const keys = [
      `user_${result.id}`,
      "user_list",
      "user_count"
    ];
    
    if (result.status === "active") {
      keys.push("active_users");
    }
    
    return keys;
  }
});
```

## Common Mistakes

### ❌ Forgetting to disable auto-uncache
```typescript
// This will show a warning and won't work properly
const prisma = new PrismaClient().$extends(
  cacheExtension({ cache, useAutoUncache: true })
);
```

### ❌ Using cache without explicit keys
```typescript
// Hard to invalidate later
await prisma.user.findMany({ cache: true });
```

### ❌ Not invalidating related caches
```typescript
// User list cache becomes stale
await prisma.user.create({
  data: { name: "New User" }
  // Missing: uncache: ["user_list"]
});
```

## Troubleshooting

**Problem**: Getting a warning about useAutoUncache  
**Solution**: Set `useAutoUncache: false` in the configuration

**Problem**: Cache not invalidating  
**Solution**: Make sure you're specifying the correct keys in `uncache` parameter

**Problem**: Stale cache entries  
**Solution**: Reduce TTL values or ensure you're invalidating all related keys

## More Information

- [Full Integration Guide](./TWEMPROXY_INTEGRATION.md) - Detailed documentation
- [Issue Analysis](./TWEMPROXY_ISSUE_SUMMARY.md) - Technical deep dive
- [Twemproxy Docs](https://github.com/twitter/twemproxy) - Twemproxy documentation
