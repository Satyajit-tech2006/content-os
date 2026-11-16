import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().default(168),
});

export const env = EnvSchema.parse(process.env);
