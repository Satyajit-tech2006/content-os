import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_STORAGE_ROOT = path.resolve(__dirname, "../../../../.contentos-storage");

export async function storeArtifact(storageKey: string, content: string | Buffer): Promise<{ backend: string; bytes: number }> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const fullPath = path.join(LOCAL_STORAGE_ROOT, storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buf);
  return { backend: "local-object-store", bytes: buf.byteLength };
}
