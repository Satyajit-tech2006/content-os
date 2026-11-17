import { z } from "zod";

export const ShotPresetSchema = z.enum([
  "turnaround_sheet",
  "editorial_portrait",
  "streetwear_lifestyle",
  "studio_fashion",
  "fitness_athletic",
  "cinematic_closeup",
]);

export const CharacterProjectSchema = z.object({
  id: z.string().min(2).regex(/^[a-z0-9-]+$/),
  name: z.string().min(2),
  tagline: z.string().default(""),
  seed: z.number().int().nonnegative(),
  appearance: z.object({
    ageRange: z.string(),
    ethnicity: z.string(),
    faceShape: z.string(),
    eyeColor: z.string(),
    hairStyle: z.string(),
    hairColor: z.string(),
    skinTone: z.string(),
    distinctiveMarks: z.array(z.string()).default([]),
  }),
  wardrobe: z.object({
    primaryOutfit: z.string(),
    casualOutfit: z.string().default(""),
    formalOutfit: z.string().default(""),
    accessories: z.array(z.string()).default([]),
    colorPalette: z.array(z.string()).default(["#0f172a", "#f8fafc", "#f59e0b"]),
  }),
  styleAnchor: z.string(),
  negativePrompt: z.string(),
  createdAt: z.string(),
});

export type CharacterProject = z.infer<typeof CharacterProjectSchema>;
export type ShotPreset = z.infer<typeof ShotPresetSchema>;
