import fs from "node:fs";
import path from "node:path";
import { CharacterProjectSchema, type CharacterProject } from "./schema.js";

const PROJECTS_ROOT = path.resolve("apps/female/projects");

export function ensureProjectsRoot(): void {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

export function getProjectDir(id: string): string {
  return path.join(PROJECTS_ROOT, id);
}

export function listCharacterProjects(): CharacterProject[] {
  ensureProjectsRoot();
  const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  const projects: CharacterProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(PROJECTS_ROOT, entry.name, "character.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      projects.push(CharacterProjectSchema.parse(raw));
    } catch {
      // Skip malformed project folder
    }
  }
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCharacterProject(id: string): CharacterProject | null {
  const metaPath = path.join(getProjectDir(id), "character.json");
  if (!fs.existsSync(metaPath)) return null;
  return CharacterProjectSchema.parse(JSON.parse(fs.readFileSync(metaPath, "utf8")));
}

export function saveCharacterProject(project: CharacterProject): CharacterProject {
  const parsed = CharacterProjectSchema.parse(project);
  const dir = getProjectDir(parsed.id);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(parsed, null, 2), "utf8");
  return parsed;
}

export function listProjectShots(id: string): unknown[] {
  const shotsDir = path.join(getProjectDir(id), "shots");
  if (!fs.existsSync(shotsDir)) return [];
  return fs
    .readdirSync(shotsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(shotsDir, f), "utf8")));
}
