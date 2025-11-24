import { Prisma, PrismaClient } from "@prisma/client";
import { createCache } from "cache-manager";
import { Keyv } from "keyv";
import assert from "node:assert";
import test from "node:test";
import cacheExtension from "../src";

/**
 * Mock store that simulates a Twemproxy/Redis setup without iterator support
 */
class TwemproxyMockStore {
  private data: Map<string, { value: any; ttl?: number; created: number }> =
    new Map();

  async get(key: string): Promise<any | undefined> {
    const entry = this.data.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (entry.ttl) {
      const age = Date.now() - entry.created;
      if (age > entry.ttl) {
        this.data.delete(key);
        return undefined;
      }
    }
    return entry.value;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    this.data.set(key, {
      value,
      ttl,
      created: Date.now(),
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  // Intentionally NOT implementing iterator to simulate Twemproxy behavior
  // iterator is what breaks with Twemproxy since it doesn't support SCAN

  // Helper method for tests
  getSize(): number {
    return this.data.size;
  }

  getAllKeys(): string[] {
    return Array.from(this.data.keys());
  }
}

test("Twemproxy compatibility", { only: true }, async (t) => {
  const mockStore = new TwemproxyMockStore();
  const keyv = new Keyv({ store: mockStore as any });
  const cache = createCache({
    ttl: 10000,
    stores: [keyv],
  });

  await t.test(
    "should warn when useAutoUncache is true with non-iterator store",
    async () => {
      // Capture console.warn output
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        warnings.push(args.join(" "));
      };

      try {
        new PrismaClient().$extends(
          cacheExtension({ cache, useAutoUncache: true }),
        );

        // Should have logged a warning
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes("useAutoUncache is enabled"));
        assert.ok(warnings[0].includes("Twemproxy"));
      } finally {
        console.warn = originalWarn;
      }
    },
  );

  await t.test(
    "should NOT warn when useAutoUncache is false",
    async () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        warnings.push(args.join(" "));
      };

      try {
        new PrismaClient().$extends(
          cacheExtension({ cache, useAutoUncache: false }),
        );

        // Should NOT have logged a warning
        assert.strictEqual(warnings.length, 0);
      } finally {
        console.warn = originalWarn;
      }
    },
  );

  await t.test(
    "manual uncaching should work without iterator support",
    async () => {
      await mockStore.clear();

      const prisma = new PrismaClient().$extends(
        cacheExtension({ cache, useAutoUncache: false }),
      );

      // Create test data
      await prisma.user.deleteMany();
      await prisma.user.create({
        data: {
          id: 1,
          string: "test",
          decimal: new Prisma.Decimal("10.5"),
          bigint: BigInt(123),
          float: 1.5,
          timestamp: new Date(),
          bytes: Buffer.from("test"),
        },
      });

      // Cache some queries with known keys
      await prisma.user.findMany({
        cache: {
          key: "all_users",
          ttl: 60000,
        },
      });

      await prisma.user.findUnique({
        where: { id: 1 },
        cache: {
          key: "user_1",
          ttl: 60000,
        },
      });

      // Verify cache entries exist
      assert.ok(await cache.get("all_users"));
      assert.ok(await cache.get("user_1"));
      assert.strictEqual(mockStore.getSize(), 2);

      // Update with manual uncaching
      await prisma.user.update({
        where: { id: 1 },
        data: { string: "updated" },
        uncache: ["all_users", "user_1"],
      });

      // Verify cache entries were deleted
      assert.strictEqual(await cache.get("all_users"), null);
      assert.strictEqual(await cache.get("user_1"), null);
      assert.strictEqual(mockStore.getSize(), 0);
    },
  );

  await t.test(
    "manual uncaching with function should work",
    async () => {
      await mockStore.clear();

      const prisma = new PrismaClient().$extends(
        cacheExtension({ cache, useAutoUncache: false }),
      );

      await prisma.user.deleteMany();
      await prisma.user.create({
        data: {
          id: 2,
          string: "test2",
          decimal: new Prisma.Decimal("20.5"),
          bigint: BigInt(456),
          float: 2.5,
          timestamp: new Date(),
          bytes: Buffer.from("test2"),
        },
      });

      // Cache with predictable key
      await prisma.user.findUnique({
        where: { id: 2 },
        cache: {
          key: "user_2",
          ttl: 60000,
        },
      });

      assert.ok(await cache.get("user_2"));

      // Update with function-based uncaching
      await prisma.user.update({
        where: { id: 2 },
        data: { string: "updated2" },
        uncache: (result) => [`user_${result.id}`, "all_users"],
      });

      // Verify deletion
      assert.strictEqual(await cache.get("user_2"), null);
    },
  );

  await t.test(
    "manual uncaching with namespace should work",
    async () => {
      await mockStore.clear();

      const prisma = new PrismaClient().$extends(
        cacheExtension({ cache, useAutoUncache: false }),
      );

      await prisma.user.deleteMany();

      // Cache with namespace
      await prisma.user.findMany({
        cache: {
          namespace: "users",
          key: "list",
          ttl: 60000,
        },
      });

      assert.ok(await cache.get("users:list"));

      // Delete using namespace format
      await prisma.user.create({
        data: {
          id: 3,
          string: "test3",
          decimal: new Prisma.Decimal("30.5"),
          bigint: BigInt(789),
          float: 3.5,
          timestamp: new Date(),
          bytes: Buffer.from("test3"),
        },
        uncache: [
          {
            namespace: "users",
            key: "list",
          },
        ],
      });

      // Verify deletion
      assert.strictEqual(await cache.get("users:list"), null);
    },
  );

  await t.test(
    "automatic uncaching should NOT work without iterator (no error, just no-op)",
    async () => {
      await mockStore.clear();

      const prisma = new PrismaClient().$extends(
        cacheExtension({ cache, useAutoUncache: true }),
      );

      await prisma.user.deleteMany();
      await prisma.user.create({
        data: {
          id: 4,
          string: "test4",
          decimal: new Prisma.Decimal("40.5"),
          bigint: BigInt(101),
          float: 4.5,
          timestamp: new Date(),
          bytes: Buffer.from("test4"),
        },
      });

      // Cache a query
      await prisma.user.findMany({
        cache: true,
      });

      assert.strictEqual(mockStore.getSize(), 1);
      const keysBefore = mockStore.getAllKeys();

      // Perform write operation - with iterator, this would clear cache
      // Without iterator, cache remains (which is the bug we're documenting)
      await prisma.user.update({
        where: { id: 4 },
        data: { string: "updated4" },
      });

      // Cache still exists (demonstrating the limitation)
      assert.strictEqual(mockStore.getSize(), 1);
      const keysAfter = mockStore.getAllKeys();
      assert.deepStrictEqual(keysBefore, keysAfter);

      // This is expected behavior with Twemproxy - auto uncaching doesn't work
    },
  );
});
