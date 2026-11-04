import { PrismaClient } from "@prisma/client";
import path from "path";

// ── Database URL Resolution ───────────────────────────────────────
// Resolves relative SQLite paths against process.cwd() so the application
// is completely agnostic to host directory hierarchies and machine users.
function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL;
  if (!envUrl) {
    return `file:${path.resolve(process.cwd(), "db/custom.db")}`;
  }
  if (envUrl.startsWith("file:")) {
    const rawPath = envUrl.slice(5);
    if (!path.isAbsolute(rawPath)) {
      const cleanPath = rawPath.replace(/^(\.\/|\.\.\/)+/, "");
      return `file:${path.resolve(process.cwd(), cleanPath)}`;
    }
  }
  return envUrl;
}

// ── Zero-Lock SQLite Optimization Pragmas ──────────────────────────
// WAL mode allows concurrent readers and writers without lock contention.
// synchronous=NORMAL reduces fsync stalls while preserving durability,
// and busy_timeout=5000 eliminates immediate locked errors.
async function applyPragmas(client: PrismaClient) {
  try {
    await client.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await client.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    await client.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
  } catch (err) {
    console.warn("[db] Failed to apply SQLite optimization pragmas:", err);
  }
}

// ── Self-Healing SQLite Pool ──────────────────────────────────────
function createDb() {
  const resolvedUrl = resolveDatabaseUrl();
  const base = new PrismaClient({
    datasources: {
      db: {
        url: resolvedUrl,
      },
    },
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  // Apply pragmas on initialization
  void applyPragmas(base);

  let recovery: Promise<void> | null = null;
  const healPool = (): Promise<void> => {
    if (!recovery) {
      recovery = base
        .$disconnect()
        .catch(() => {})
        .then(() => applyPragmas(base))
        .finally(() => {
          setTimeout(() => {
            recovery = null;
          }, 250);
        });
    }
    return recovery;
  };

  const isReadOnlySqlite = (e: unknown): boolean =>
    String((e as Error)?.message ?? "").includes(
      "attempt to write a readonly database"
    );

  return base.$extends({
    query: {
      $allModels: {
        $allOperations: async ({ args, query }) => {
          try {
            return await query(args);
          } catch (e) {
            if (!isReadOnlySqlite(e)) throw e;
            console.warn(
              "[db] Stale SQLite connection detected — reconnecting and retrying once"
            );
            await healPool();
            return await query(args);
          }
        },
      },
    },
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createDb> | undefined;
};

// Enforce singleton Prisma client instantiation across hot reloads in development and production
export const db = globalForPrisma.prisma ?? createDb();
globalForPrisma.prisma = db;
