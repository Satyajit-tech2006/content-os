import { PrismaClient } from "@prisma/client";

function buildPooledUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let out = url.replace(/connection_limit=\d+/g, "connection_limit=20");
  if (!out.includes("connection_limit=")) {
    out += (out.includes("?") ? "&" : "?") + "connection_limit=20";
  }
  if (!out.includes("pool_timeout=")) {
    out += "&pool_timeout=30";
  }
  return out;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const pooledUrl = buildPooledUrl(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: pooledUrl ? { db: { url: pooledUrl } } : undefined,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";
