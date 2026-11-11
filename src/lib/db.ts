import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Only log queries in development when explicitly enabled via LOG_QUERIES=1.
// The previous `log: ['query']` setting dumped every SQL statement to the
// console on every request — harmless but extremely noisy, and it made real
// errors hard to spot in dev.log. In production we only surface warnings and
// errors. Set LOG_QUERIES=1 in .env if you need to debug SQL.
const logConfig = ['warn', 'error'] as const

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV !== 'production' && process.env.LOG_QUERIES === '1'
        ? ['query', 'warn', 'error']
        : (logConfig as unknown as ('query' | 'info' | 'warn' | 'error')[]),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
