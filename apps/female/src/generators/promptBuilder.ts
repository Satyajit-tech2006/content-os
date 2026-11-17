import { type CharacterProject, type ShotPreset } from "../characters/schema.js";

const PRESET_TEMPLATES: Record<
  ShotPreset,
  { camera: string; sceneDefault: string; outfitSlot: "primary" | "casual" | "formal" }
> = {
  turnaround_sheet: {
    camera: "character reference turnaround sheet, front view, side profile, and 3/4 view on clean neutral studio backdrop, even softbox lighting",
    sceneDefault: "neutral pose, consistent proportions across all angles",
    outfitSlot: "primary",
  },
  editorial_portrait: {
    camera: "85mm f/1.4 portrait photography, shallow depth of field, natural skin texture, soft rim light",
    sceneDefault: "standing in a modern sunlit architectural loft, calm confident gaze",
    outfitSlot: "primary",
  },
  streetwear_lifestyle: {
    camera: "35mm candid street photography, golden hour urban lighting, natural film grain",
    sceneDefault: "walking along a bustling Tokyo or Mumbai cafe street at dusk",
    outfitSlot: "casual",
  },
  studio_fashion: {
    camera: "full-body fashion lookbook shot, medium format camera, crisp studio strobe lighting",
    sceneDefault: "editorial fashion pose on seamless cyclorama backdrop",
    outfitSlot: "formal",
  },
  fitness_athletic: {
    camera: "50mm dynamic lifestyle photography, crisp morning sunlight, high shutter speed",
    sceneDefault: "outdoor rooftop terrace after a morning run, energetic natural expression",
    outfitSlot: "casual",
  },
  cinematic_closeup: {
    camera: "cinematic anamorphic close-up, moody teal-and-amber lighting, sharp iris catchlights",
    sceneDefault: "looking thoughtfully out a rain-streaked window at night",
    outfitSlot: "primary",
  },
};

export function compileCharacterShot(
  character: CharacterProject,
  preset: ShotPreset,
  customScene?: string
) {
  const tpl = PRESET_TEMPLATES[preset];
  const { appearance, wardrobe } = character;

  const chosenOutfit =
    tpl.outfitSlot === "casual" && wardrobe.casualOutfit
      ? wardrobe.casualOutfit
      : tpl.outfitSlot === "formal" && wardrobe.formalOutfit
        ? wardrobe.formalOutfit
        : wardrobe.primaryOutfit;

  const identityTokens = [
    `consistent persona ${character.name}`,
    `${appearance.ageRange} ${appearance.ethnicity} woman`,
    `${appearance.faceShape} facial structure`,
    `${appearance.eyeColor} eyes`,
    `${appearance.hairStyle} ${appearance.hairColor} hair`,
    `${appearance.skinTone} skin tone`,
    appearance.distinctiveMarks.length > 0 ? appearance.distinctiveMarks.join(", ") : "",
    `wearing ${chosenOutfit}`,
    wardrobe.accessories.length > 0 ? `accessories: ${wardrobe.accessories.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const scene = customScene?.trim() || tpl.sceneDefault;
  const positivePrompt = `${identityTokens}, ${scene}, ${tpl.camera}, ${character.styleAnchor}`;

  return {
    shotId: `shot-${Date.now()}`,
    characterId: character.id,
    characterName: character.name,
    preset,
    seed: character.seed,
    positivePrompt,
    negativePrompt: `${character.negativePrompt}, nsfw, nude, explicit, deformed hands, extra fingers, inconsistent face`,
    workflowPayload: {
      seed: character.seed,
      steps: 30,
      cfgScale: 6.5,
      sampler: "dpmpp_2m_sde",
      scheduler: "karras",
      width: preset === "turnaround_sheet" ? 1344 : 832,
      height: preset === "turnaround_sheet" ? 768 : 1216,
    },
    createdAt: new Date().toISOString(),
  };
}
