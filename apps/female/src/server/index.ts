import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { CharacterProjectSchema, ShotPresetSchema } from "../characters/schema.js";
import {
  getCharacterProject,
  getProjectDir,
  listCharacterProjects,
  listProjectShots,
  saveCharacterProject,
} from "../characters/store.js";
import { compileCharacterShot } from "../generators/promptBuilder.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve("apps/female/public")));

// Seed two realistic starter character projects if none exist yet
if (listCharacterProjects().length === 0) {
  saveCharacterProject({
    id: "aria-vance",
    name: "Aria Vance",
    tagline: "Tech & Design Creator Persona",
    seed: 4829104,
    appearance: {
      ageRange: "24-year-old",
      ethnicity: "South Asian",
      faceShape: "oval with soft defined jawline",
      eyeColor: "warm amber-brown",
      hairStyle: "shoulder-length layered waves with curtain bangs",
      hairColor: "jet black",
      skinTone: "warm olive",
      distinctiveMarks: ["subtle beauty mark below left eye"],
    },
    wardrobe: {
      primaryOutfit: "matte black cropped jacket over ivory ribbed top and high-waisted charcoal trousers",
      casualOutfit: "oversized vintage washed hoodie, relaxed denim, white sneakers",
      formalOutfit: "tailored espresso blazer, silk camisole, gold minimalist watch",
      accessories: ["thin silver hoop earrings", "minimalist analog wristwatch"],
      colorPalette: ["#0f172a", "#f8fafc", "#f59e0b"],
    },
    styleAnchor: "photorealistic editorial portrait, natural skin pores, soft studio rim light, 8k RAW photo",
    negativePrompt: "inconsistent face, changing hair length, plastic skin, blurry, lowres, watermark",
    createdAt: new Date().toISOString(),
  });
}

app.get("/api/projects", (_req, res) => {
  res.json({ projects: listCharacterProjects() });
});

app.post("/api/projects", (req, res) => {
  try {
    const rawName = String(req.body.name || "Character");
    const slug =
      req.body.id ||
      rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") +
        "-" +
        Math.floor(100 + Math.random() * 900);

    const project = CharacterProjectSchema.parse({
      ...req.body,
      id: slug,
      seed: Number(req.body.seed ?? Math.floor(100000 + Math.random() * 8999999)),
      createdAt: new Date().toISOString(),
    });
    saveCharacterProject(project);
    res.status(201).json({ project });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid character project" });
  }
});

app.get("/api/projects/:id", (req, res) => {
  const project = getCharacterProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Character project not found" });
  res.json({ project, shots: listProjectShots(project.id) });
});

app.post("/api/projects/:id/shots", (req, res) => {
  const project = getCharacterProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Character project not found" });

  const preset = ShotPresetSchema.parse(req.body.preset || "editorial_portrait");
  const shot = compileCharacterShot(project, preset, req.body.customScene);
  const outPath = path.join(getProjectDir(project.id), "shots", `${shot.shotId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(shot, null, 2), "utf8");
  res.status(201).json({ shot });
});

const PORT = Number(process.env.FEMALE_STUDIO_PORT || 4100);
app.listen(PORT, () => {
  console.log(`Character Studio running at http://localhost:${PORT}`);
});
