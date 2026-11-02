import { PrismaClient } from '@prisma/client'

// ── Self-healing SQLite pool ──────────────────────────────────────
// The database file is RUNTIME STATE that git can replace under the
// running server (session-snapshot automation, stash/checkout/reset
// rewrite the tracked file). Prisma connections opened against a
// since-replaced or briefly-unwritable file keep failing every write
// with SqliteError "attempt to write a readonly database" (extended
// code 8 when the file was unwritable at open, 1032 when the file
// was swapped under a live connection) — FOREVER, even after the
// file on disk is writable again, because a read-only SQLite
// connection never upgrades.
//
// The heal is exact: drop the pool; the next query reopens the file
// BY PATH and picks up whatever is on disk now. Retrying is safe
// because a read-only write was rejected without side effects —
// unlike connection-closed errors, which are ambiguous (the write
// may have landed) and must surface, never retry.
function createDb() {
  const base = new PrismaClient({
    log: ['query'],
  })

  let recovery: Promise<void> | null = null
  const healPool = (): Promise<void> => {
    if (!recovery) {
      recovery = base
        .$disconnect()
        .catch(() => {})
        .finally(() => {
          // Re-arm shortly after so a future file swap can heal too.
          setTimeout(() => {
            recovery = null
          }, 250)
        })
    }
    return recovery
  }

  const isReadOnlySqlite = (e: unknown): boolean =>
    String((e as Error)?.message ?? '').includes(
      'attempt to write a readonly database'
    )

  return base.$extends({
    query: {
      $allModels: {
        $allOperations: async ({ args, query }) => {
          try {
            return await query(args)
          } catch (e) {
            if (!isReadOnlySqlite(e)) throw e
            console.warn(
              '[db] stale SQLite connection detected (database file was replaced or briefly unwritable) — reconnecting and retrying once'
            )
            await healPool()
            return await query(args)
          }
        },
      },
    },
  })
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createDb> | undefined
}

export const db = globalForPrisma.prisma ?? createDb()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
