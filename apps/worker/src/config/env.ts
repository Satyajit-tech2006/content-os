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
  AI_PROVIDER: z.enum(["ollama", "gemini", "simulated"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_DEFAULT_MODEL: z.string().default("qwen3:4b"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
});

export const env = EnvSchema.parse(process.env);
