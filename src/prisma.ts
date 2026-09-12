import { PrismaClient } from '@prisma/client';

// Single shared instance — index.ts and push.ts (and anything else) all
// import this rather than each constructing their own PrismaClient, which
// would open a separate connection pool per instance for no reason.
export const prisma = new PrismaClient();
