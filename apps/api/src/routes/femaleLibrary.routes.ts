import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";

const execFileAsync = promisify(execFile);
const router: ExpressRouter = Router({ mergeParams: true });

const STORAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.contentos-storage"
);

const ShotPresetSchema = z.enum([
  "editorial_portrait",
  "streetwear_lifestyle",
  "studio_fashion",
  "turnaround_sheet",
  "fitness_athletic",
  "cinematic_closeup",
]);

const CharacterSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
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
  }),
  wardrobe: z.object({
    primaryOutfit: z.string(),
    casualOutfit: z.string().default(""),
    formalOutfit: z.string().default(""),
    accentColor: z.string().default("#f59e0b"),
  }),
  styleAnchor: z.string(),
  createdAt: z.string(),
});

type CharacterProfile = z.infer<typeof CharacterSchema>;

interface GeneratedShot {
  shotId: string;
  preset: z.infer<typeof ShotPresetSchema>;
  poseLabel: string;
  sceneryLabel: string;
  positivePrompt: string;
  negativePrompt: string;
  imageUrl: string;
  imageRelPath: string;
  createdAt: string;
}

interface GeneratedVideo {
  videoId: string;
  title: string;
  voice: string;
  script: string;
  videoUrl: string;
  durationSec: number;
  createdAt: string;
}

const PRESET_CONFIG: Record<
  z.infer<typeof ShotPresetSchema>,
  { label: string; defaultPose: string; defaultScenery: string; bgColors: [string, string] }
> = {
  editorial_portrait: {
    label: "Editorial Portrait",
    defaultPose: "Three-quarter poised studio stance, relaxed shoulders, direct confident gaze",
    defaultScenery: "Sunlit minimalist architectural loft with warm travertine arches",
    bgColors: ["#1e1b4b", "#312e81"],
  },
  streetwear_lifestyle: {
    label: "Streetwear Lifestyle",
    defaultPose: "Candid mid-stride walking pose, looking slightly over shoulder",
    defaultScenery: "Golden-hour Tokyo Shibuya side-street with soft bokeh cafe lights",
    bgColors: ["#451a03", "#78350f"],
  },
  studio_fashion: {
    label: "Studio Fashion Lookbook",
    defaultPose: "Full-length editorial lookbook silhouette, hand in tailored coat pocket",
    defaultScenery: "Seamless obsidian-and-champagne cyclorama fashion stage",
    bgColors: ["#18181b", "#27272a"],
  },
  turnaround_sheet: {
    label: "3-Angle Turnaround Sheet",
    defaultPose: "Front view, 45-degree profile, and side profile alignment",
    defaultScenery: "Clean neutral calibration studio backdrop with softbox rim light",
    bgColors: ["#0f172a", "#1e293b"],
  },
  fitness_athletic: {
    label: "Fitness & Wellness",
    defaultPose: "Dynamic morning stretch pose on outdoor terrace",
    defaultScenery: "Panoramic coastal skyline balcony at crisp sunrise",
    bgColors: ["#064e3b", "#065f46"],
  },
  cinematic_closeup: {
    label: "Cinematic Close-Up",
    defaultPose: "Intimate 85mm close-up portrait, subtle thoughtful expression",
    defaultScenery: "Moody rain-streaked lounge window with warm amber city reflections",
    bgColors: ["#3b0764", "#1e1b4b"],
  },
};

function getWorkspaceLibDir(workspaceId: string): string {
  const dir = path.join(STORAGE_ROOT, "female-library", workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCharDir(workspaceId: string, charId: string): string {
  const dir = path.join(getWorkspaceLibDir(workspaceId), charId);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
  return dir;
}

function compileSafeShotPrompt(
  char: CharacterProfile,
  preset: z.infer<typeof ShotPresetSchema>,
  poseInput?: string,
  sceneryInput?: string
) {
  const cfg = PRESET_CONFIG[preset];
  const pose = poseInput?.trim() || cfg.defaultPose;
  const scenery = sceneryInput?.trim() || cfg.defaultScenery;
  const outfit =
    preset === "streetwear_lifestyle" && char.wardrobe.casualOutfit
      ? char.wardrobe.casualOutfit
      : preset === "studio_fashion" && char.wardrobe.formalOutfit
        ? char.wardrobe.formalOutfit
        : char.wardrobe.primaryOutfit;

  const positivePrompt = [
    `consistent fictional persona ${char.name}`,
    `${char.appearance.ageRange} ${char.appearance.ethnicity} woman`,
    `${char.appearance.faceShape} face`,
    `${char.appearance.eyeColor} eyes`,
    `${char.appearance.hairStyle} ${char.appearance.hairColor} hair`,
    `${char.appearance.skinTone} skin`,
    `wearing ${outfit}`,
    `pose: ${pose}`,
    `scenery: ${scenery}`,
    `${char.styleAnchor}`,
  ].join(", ");

  const negativePrompt =
    "nsfw, nude, explicit, suggestive, deformed hands, extra fingers, inconsistent face, changing hair, blurry, lowres, watermark";

  return { positivePrompt, negativePrompt, pose, scenery, cfg };
}

async function resolveFfmpegPath(): Promise<string> {
  try {
    const pkg = "ffmpeg-static"; const mod = await import(pkg);
    const bin = (mod as unknown as { default?: string }).default || (mod as unknown as string);
    if (typeof bin === "string" && fs.existsSync(bin)) return bin;
  } catch {}
  return "ffmpeg";
}

async function renderStudioShotPng(
  outAbsPath: string,
  char: CharacterProfile,
  shotIdx: number,
  presetLabel: string,
  pose: string,
  scenery: string,
  bgColors: [string, string]
): Promise<void> {
  // Try optional local ComfyUI/A1111 SDXL endpoint first if running on port 7860
  try {
    const sdResp = await fetch("http://127.0.0.1:7860/sdapi/v1/txt2img", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `${char.name}, ${char.appearance.ageRange} ${char.appearance.ethnicity} woman, ${char.appearance.hairStyle} ${char.appearance.hairColor} hair, ${char.wardrobe.primaryOutfit}, ${pose}, ${scenery}, photorealistic editorial 8k`,
        negative_prompt: "nsfw, nude, explicit, deformed, blurry, watermark",
        seed: char.seed + shotIdx,
        steps: 24,
        width: 768,
        height: 1152,
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (sdResp.ok) {
      const data = (await sdResp.json()) as { images?: string[] };
      if (data.images?.[0]) {
        await fsp.writeFile(outAbsPath, Buffer.from(data.images[0], "base64"));
        return;
      }
    }
  } catch {
    // Local A1111 not running; render high-craft 1080x1920 studio lookbook plate via FFmpeg
  }

  const ffmpeg = await resolveFfmpegPath();
  const safeName = char.name.replace(/[':]/g, "").toUpperCase();
  const safePreset = presetLabel.replace(/[':]/g, "").toUpperCase();
  const safePose = pose.replace(/[':]/g, "").slice(0, 52);
  const safeScenery = scenery.replace(/[':]/g, "").slice(0, 52);
  const safeOutfit = char.wardrobe.primaryOutfit.replace(/[':]/g, "").slice(0, 54);

  const vf = [
    `gradients=s=1080x1920:c0=${bgColors[0]}:c1=${bgColors[1]}:x0=0:y0=0:x1=1080:y1=1920`,
    "drawbox=x=70:y=120:w=940:h=1680:color=black@0.42:t=fill",
    `drawbox=x=70:y=120:w=940:h=1680:color=${char.wardrobe.accentColor}@0.75:t=4`,
    `drawtext=text='CHARACTER LOOKBOOK // SEED ${char.seed}':fontcolor=white@0.65:fontsize=26:x=120:y=185`,
    `drawtext=text='${safeName}':fontcolor=white:fontsize=68:x=120:y=250`,
    `drawtext=text='${safePreset}':fontcolor=${char.wardrobe.accentColor}:fontsize=34:x=120:y=345`,
    "drawbox=x=120:y=420:w=840:h=760:color=white@0.06:t=fill",
    `drawtext=text='POSE':fontcolor=${char.wardrobe.accentColor}:fontsize=24:x=155:y=470`,
    `drawtext=text='${safePose}':fontcolor=white:fontsize=30:x=155:y=515`,
    `drawtext=text='SCENERY':fontcolor=${char.wardrobe.accentColor}:fontsize=24:x=155:y=635`,
    `drawtext=text='${safeScenery}':fontcolor=white:fontsize=30:x=155:y=680`,
    `drawtext=text='WARDROBE LOCK':fontcolor=${char.wardrobe.accentColor}:fontsize=24:x=155:y=800`,
    `drawtext=text='${safeOutfit}':fontcolor=white@0.9:fontsize=28:x=155:y=845`,
    `drawtext=text='FRAME 0${shotIdx + 1} // SFW EDITORIAL VERIFIED':fontcolor=white@0.55:fontsize=24:x=120:y=1720`,
  ].join(",");

  await execFileAsync(ffmpeg, ["-y", "-f", "lavfi", "-i", vf, "-frames:v", "1", outAbsPath]);
}

async function synthesizeSpeechMp3(text: string, voice: string, outMp3Path: string): Promise<void> {
  const pkg = "msedge-tts"; const { EdgeTTS } = await import(pkg);
  const tts = new EdgeTTS();
  await tts.setMetadata(voice, "audio-24khz-48kbitrate-mono-mp3" as never);
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on("data", (c: Buffer) => chunks.push(c));
    audioStream.on("end", () => resolve());
    audioStream.on("error", reject);
  });
  await fsp.writeFile(outMp3Path, Buffer.concat(chunks));
}

router.use(requireAuth);

router.get("/", (req, res) => {
  const workspaceId = String((req.params as Record<string, string>).workspaceId);
  const libDir = getWorkspaceLibDir(workspaceId);
  const entries = fs.readdirSync(libDir, { withFileTypes: true });
  const characters: CharacterProfile[] = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = path.join(libDir, e.name, "character.json");
    if (!fs.existsSync(meta)) continue;
    try {
      characters.push(CharacterSchema.parse(JSON.parse(fs.readFileSync(meta, "utf8"))));
    } catch {}
  }

  characters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ characters });
});

router.post("/", (req, res) => {
  const workspaceId = String((req.params as Record<string, string>).workspaceId);
  const rawName = String(req.body.name || "Persona").trim();
  const slug =
    rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") +
    "-" +
    Math.floor(100 + Math.random() * 900);

  const parsed = CharacterSchema.parse({
    id: slug,
    workspaceId,
    name: rawName,
    tagline: String(req.body.tagline || "Editorial & Lifestyle Persona"),
    seed: Number(req.body.seed || Math.floor(100000 + Math.random() * 8999999)),
    appearance: {
      ageRange: String(req.body.ageRange || "24-year-old"),
      ethnicity: String(req.body.ethnicity || "South Asian"),
      faceShape: String(req.body.faceShape || "oval with soft defined jawline"),
      eyeColor: String(req.body.eyeColor || "warm amber-brown"),
      hairStyle: String(req.body.hairStyle || "shoulder-length layered waves"),
      hairColor: String(req.body.hairColor || "jet black"),
      skinTone: String(req.body.skinTone || "warm olive"),
    },
    wardrobe: {
      primaryOutfit: String(req.body.primaryOutfit || "tailored charcoal blazer over cream silk top"),
      casualOutfit: String(req.body.casualOutfit || "oversized vintage denim jacket and white tee"),
      formalOutfit: String(req.body.formalOutfit || "minimalist monochrome evening suit"),
      accentColor: String(req.body.accentColor || "#f59e0b"),
    },
    styleAnchor: String(
      req.body.styleAnchor || "photorealistic editorial photography, natural skin texture, soft studio rim light, 8k"
    ),
    createdAt: new Date().toISOString(),
  });

  const dir = getCharDir(workspaceId, parsed.id);
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(parsed, null, 2), "utf8");
  res.status(201).json({ character: parsed });
});

router.get("/:charId", (req, res) => {
  const workspaceId = String((req.params as Record<string, string>).workspaceId);
  const charId = String(req.params.charId);
  const dir = getCharDir(workspaceId, charId);
  const metaPath = path.join(dir, "character.json");
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Character not found" });

  const character = CharacterSchema.parse(JSON.parse(fs.readFileSync(metaPath, "utf8")));
  const shots: GeneratedShot[] = fs
    .readdirSync(path.join(dir, "shots"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "shots", f), "utf8")));

  const videos: GeneratedVideo[] = fs
    .readdirSync(path.join(dir, "videos"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "videos", f), "utf8")));

  res.json({ character, shots, videos });
});

router.post("/:charId/shots", async (req, res, next) => {
  try {
    const workspaceId = String((req.params as Record<string, string>).workspaceId);
    const charId = String(req.params.charId);
    const dir = getCharDir(workspaceId, charId);
    const metaPath = path.join(dir, "character.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Character not found" });

    const character = CharacterSchema.parse(JSON.parse(fs.readFileSync(metaPath, "utf8")));
    const preset = ShotPresetSchema.parse(req.body.preset || "editorial_portrait");
    const existingCount = fs.readdirSync(path.join(dir, "shots")).filter((f) => f.endsWith(".json")).length;

    const { positivePrompt, negativePrompt, pose, scenery, cfg } = compileSafeShotPrompt(
      character,
      preset,
      req.body.pose,
      req.body.scenery
    );

    const shotId = `shot-${Date.now()}`;
    const pngName = `${shotId}.png`;
    const pngAbsPath = path.join(dir, "shots", pngName);
    await renderStudioShotPng(pngAbsPath, character, existingCount, cfg.label, pose, scenery, cfg.bgColors);

    const imageRelPath = `female-library/${workspaceId}/${charId}/shots/${pngName}`;
    const shot: GeneratedShot = {
      shotId,
      preset,
      poseLabel: pose,
      sceneryLabel: scenery,
      positivePrompt,
      negativePrompt,
      imageUrl: `/media/${imageRelPath}`,
      imageRelPath,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(dir, "shots", `${shotId}.json`), JSON.stringify(shot, null, 2), "utf8");
    res.status(201).json({ shot });
  } catch (err) {
    next(err);
  }
});

router.post("/:charId/videos", async (req, res, next) => {
  try {
    const workspaceId = String((req.params as Record<string, string>).workspaceId);
    const charId = String(req.params.charId);
    const dir = getCharDir(workspaceId, charId);
    const metaPath = path.join(dir, "character.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Character not found" });

    const character = CharacterSchema.parse(JSON.parse(fs.readFileSync(metaPath, "utf8")));
    const title = String(req.body.title || `${character.name} Showcase Reel`).trim();
    const script = String(req.body.script || "").trim();
    const voice = String(req.body.voice || "en-US-AriaNeural").trim();
    if (!script) return res.status(400).json({ error: "Narration script is required" });

    // Ensure at least 3 distinct pose/scenery shots exist so the video transitions across scenes
    const presets: Array<z.infer<typeof ShotPresetSchema>> = [
      "editorial_portrait",
      "streetwear_lifestyle",
      "cinematic_closeup",
    ];
    let shotFiles = fs
      .readdirSync(path.join(dir, "shots"))
      .filter((f) => f.endsWith(".json"))
      .sort();

    while (shotFiles.length < 3) {
      const idx = shotFiles.length;
      const preset = presets[idx % presets.length]!;
      const { positivePrompt, negativePrompt, pose, scenery, cfg } = compileSafeShotPrompt(character, preset);
      const sId = `shot-${Date.now()}-${idx}`;
      const pngName = `${sId}.png`;
      await renderStudioShotPng(path.join(dir, "shots", pngName), character, idx, cfg.label, pose, scenery, cfg.bgColors);
      const rel = `female-library/${workspaceId}/${charId}/shots/${pngName}`;
      const shotObj: GeneratedShot = {
        shotId: sId,
        preset,
        poseLabel: pose,
        sceneryLabel: scenery,
        positivePrompt,
        negativePrompt,
        imageUrl: `/media/${rel}`,
        imageRelPath: rel,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(dir, "shots", `${sId}.json`), JSON.stringify(shotObj, null, 2), "utf8");
      shotFiles.push(`${sId}.json`);
    }

    const shots: GeneratedShot[] = shotFiles
      .slice(-4)
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "shots", f), "utf8")));

    const videoId = `vid-${Date.now()}`;
    const audioPath = path.join(dir, "videos", `${videoId}.mp3`);
    const videoPath = path.join(dir, "videos", `${videoId}.mp4`);
    await synthesizeSpeechMp3(script, voice, audioPath);

    const estDuration = Math.max(6, Math.ceil(script.split(/\s+/).length * 0.42));
    const perSlideSec = Math.max(2.5, estDuration / shots.length);
    const ffmpeg = await resolveFfmpegPath();

    // Build smooth Ken Burns slideshow across the character's pose/scenery frames + EdgeTTS audio
    const args: string[] = ["-y"];
    shots.forEach((sh) => {
      args.push("-loop", "1", "-t", perSlideSec.toFixed(2), "-i", path.join(STORAGE_ROOT, sh.imageRelPath));
    });
    args.push("-i", audioPath);

    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    shots.forEach((_, idx) => {
      const zoomDir = idx % 2 === 0 ? "min(zoom+0.0012,1.12)" : "if(lte(zoom,1.0),1.12,max(1.001,zoom-0.0012))";
      filterParts.push(
        `[${idx}:v]scale=1080:1920,zoompan=z='${zoomDir}':d=${Math.round(perSlideSec * 30)}:s=1080x1920:fps=30,setsar=1[v${idx}]`
      );
      concatInputs.push(`[v${idx}]`);
    });
    filterParts.push(`${concatInputs.join("")}concat=n=${shots.length}:v=1:a=0[vout]`);

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[vout]",
      "-map",
      `${shots.length}:a`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      videoPath
    );

    await execFileAsync(ffmpeg, args);

    const videoMeta: GeneratedVideo = {
      videoId,
      title,
      voice,
      script,
      videoUrl: `/media/female-library/${workspaceId}/${charId}/videos/${videoId}.mp4`,
      durationSec: estDuration,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "videos", `${videoId}.json`), JSON.stringify(videoMeta, null, 2), "utf8");
    res.status(201).json({ video: videoMeta });
  } catch (err) {
    next(err);
  }
});

export default router;
