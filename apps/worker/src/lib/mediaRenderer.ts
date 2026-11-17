import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { createCanvas, loadImage, type SKRSContext2D, type Image } from "@napi-rs/canvas";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_STORAGE_ROOT = path.resolve(__dirname, "../../../../.contentos-storage");

export type VideoStyleId =
  | "stock_ken_burns"
  | "isometric_tech" | "stickman_explainer" | "minimal_line_art"
  | "kinetic_typography"
  | "tech_hud_blueprint";

export function resolveStoragePath(storageKey: string): string {
  return path.join(LOCAL_STORAGE_ROOT, storageKey);
}

export function sanitizeNarrationText(raw: string): string {
  return raw
    .replace(/[\(\[]\s*\d+(?::\d+)?\s*s?\s*(?:[-??to]+\s*\d+(?::\d+)?\s*s?)?\s*[\)\]]/gi, " ")
    .replace(/[\(\[]\s*(?:visual|b-roll|sfx|music|cut to|scene|on screen|text)[^\)\]]*[\)\]]/gi, " ")
    .replace(/(?:^|\n)\s*(?:\d+(?::\d+)?\s*s?\s*(?:[-??]\s*\d+(?::\d+)?\s*s?)?\s*[:\-??]|(?:narrator|host|voiceover|vo)\s*:)/gi, " ")
    .replace(/[*#_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function probeDurationSec(filePath: string, fallbackSec = 15): Promise<number> {
  try {
    await execFileAsync(ffmpegPath, ["-i", filePath]);
    return fallbackSec;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (total > 0.2) return Number(total.toFixed(2));
    }
    return fallbackSec;
  }
}

function pickNeuralVoiceAndProsody(tone?: string, explicitVoice?: string): {
  voice: string;
  label: string;
} {
  if (explicitVoice) {
    return { voice: explicitVoice, label: explicitVoice };
  }
  const t = (tone || "").toLowerCase();
  if (/energetic|hype|gaming|fast|bold|punchy/.test(t)) {
    return {
      voice: "en-US-GuyNeural",
      label: "Guy Neural (Energetic Creator)",
    };
  }
  if (/warm|story|calm|documentary|cinematic/.test(t)) {
    return {
      voice: "en-US-AriaNeural",
      label: "Aria Neural (Expressive Storyteller)",
    };
  }
  return {
    voice: "en-US-AndrewNeural",
    label: "Andrew Neural (Natural Host)",
  };
}

let cachedNvencAvailable: boolean | null = null;
async function isNvencAvailable(): Promise<boolean> {
  if (cachedNvencAvailable !== null) return cachedNvencAvailable;
  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=256x256:d=0.2",
      "-c:v", "h264_nvenc",
      "-f", "null",
      "-",
    ]);
    cachedNvencAvailable = true;
  } catch {
    cachedNvencAvailable = false;
  }
  return cachedNvencAvailable;
}

export interface TimedCaptionSegment {
  lines: string[];
  spokenText: string;
  startSec: number;
  endSec: number;
  words?: Array<{ word: string; startSec: number; endSec: number }>;
}

interface WordTiming {
  word: string;
  startSec: number;
  endSec: number;
}

function buildCaptionCardsFromWordTimings(
  cleanText: string,
  wordTimings: WordTiming[],
  totalDurationSec: number,
  maxCharsPerLine: number,
  maxLinesPerCard: number
): TimedCaptionSegment[] {
  // Group words into short, punchy 4-7 word subtitle cards that fit 1-2 lines cleanly
  const rawWords = cleanText.split(/\s+/).filter(Boolean);
  const cards: Array<{ lines: string[]; spokenText: string; wordCount: number }> = [];

  let curLines: string[] = [];
  let curLine = "";
  let curWordCount = 0;

  const flushCard = () => {
    if (curLine) {
      curLines.push(curLine);
      curLine = "";
    }
    if (curLines.length > 0) {
      cards.push({
        lines: curLines,
        spokenText: curLines.join(" "),
        wordCount: curWordCount,
      });
      curLines = [];
      curWordCount = 0;
    }
  };

  for (const w of rawWords) {
    const candidate = (curLine + " " + w).trim();
    if (candidate.length <= maxCharsPerLine) {
      curLine = candidate;
      curWordCount++;
    } else {
      if (curLine) curLines.push(curLine);
      if (curLines.length >= maxLinesPerCard) {
        flushCard();
      }
      curLine = w;
      curWordCount++;
    }

    // Break card naturally at sentence punctuation so captions never bleed across sentences
    if (/[.!?]$/.test(w)) {
      flushCard();
    }
  }
  flushCard();

  if (cards.length === 0) {
    return [{ lines: [cleanText.slice(0, maxCharsPerLine)], spokenText: cleanText, startSec: 0, endSec: totalDurationSec }];
  }

  // If Edge TTS returned exact WordBoundary timings, map each card to the exact first/last spoken word timestamp!
  if (wordTimings.length >= Math.max(3, Math.floor(rawWords.length * 0.5))) {
    let wCursor = 0;
    return cards.map((card, idx) => {
      const startIdx = Math.min(wordTimings.length - 1, wCursor);
      const endIdx = Math.min(wordTimings.length - 1, wCursor + Math.max(1, card.wordCount) - 1);
      const sliceWords = wordTimings.slice(startIdx, endIdx + 1);
      wCursor += card.wordCount;

      const startSec = idx === 0 ? 0 : wordTimings[startIdx]!.startSec;
      const endSec =
        idx === cards.length - 1
          ? totalDurationSec
          : Math.max(startSec + 0.35, wordTimings[endIdx]!.endSec);

      return {
        lines: card.lines,
        spokenText: card.spokenText,
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        words: sliceWords,
      };
    });
  }

  // Fallback proportional syllable/character timing if metadata stream was empty
  const totalChars = cards.reduce((acc, c) => acc + Math.max(1, c.spokenText.length), 0);
  let cursor = 0;
  return cards.map((card) => {
    const dur = (Math.max(1, card.spokenText.length) / totalChars) * totalDurationSec;
    const out: TimedCaptionSegment = {
      lines: card.lines,
      spokenText: card.spokenText,
      startSec: Number(cursor.toFixed(3)),
      endSec: Number((cursor + dur).toFixed(3)),
    };
    cursor += dur;
    return out;
  });
}

async function attemptEdgeTtsOnce(
  text: string,
  voice: string
): Promise<{ mp3Buffer: Buffer; wordTimings: WordTiming[] }> {
  const tts = new MsEdgeTTS();
  await Promise.race([
    tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: true,
      sentenceBoundaryEnabled: true,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("EdgeTTS metadata handshake timeout (8s)")), 8000)),
  ]);

  const streamObj = tts.toStream(text) as unknown as {
    audioStream?: NodeJS.ReadableStream;
    metadataStream?: NodeJS.ReadableStream;
  };

  const audioStream: NodeJS.ReadableStream =
    streamObj && typeof streamObj.audioStream === "object"
      ? streamObj.audioStream
      : (streamObj as unknown as NodeJS.ReadableStream);

  const audioParts: Buffer[] = [];
  const wordTimings: WordTiming[] = [];

  if (streamObj?.metadataStream) {
    let metaRaw = "";
    streamObj.metadataStream.on("data", (chunk: Buffer | Uint8Array | string) => {
      metaRaw += chunk.toString();
      const lines = metaRaw.split(/\r?\n/);
      metaRaw = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as {
            Metadata?: Array<{
              Type?: string;
              Data?: { Offset?: number; Duration?: number; text?: { Text?: string } };
            }>;
          };
          for (const item of parsed.Metadata ?? []) {
            if (item.Type === "WordBoundary" && item.Data?.text?.Text) {
              const offsetTicks = Number(item.Data.Offset ?? 0);
              const durTicks = Number(item.Data.Duration ?? 0);
              wordTimings.push({
                word: item.Data.text.Text,
                startSec: offsetTicks / 10_000_000,
                endSec: (offsetTicks + durTicks) / 10_000_000,
              });
            }
          }
        } catch {
          // ignore partial JSON line
        }
      }
    });
  }

  const mp3Buffer = await Promise.race([
    new Promise<Buffer>((resolve, reject) => {
      audioStream.on("data", (d: Buffer | Uint8Array) => audioParts.push(Buffer.from(d)));
      audioStream.on("end", () => resolve(Buffer.concat(audioParts)));
      audioStream.on("error", reject);
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("EdgeTTS audio stream timeout (25s)")), 25000)),
  ]);

  if (mp3Buffer.byteLength < 2048) {
    throw new Error(`EdgeTTS returned incomplete audio (${mp3Buffer.byteLength} bytes)`);
  }

  return { mp3Buffer, wordTimings };
}

/**
 * Strictly synthesizes human neural voiceover via msedge-tts with up to 3 retry attempts
 * and exact WordBoundary timestamp extraction. NEVER falls back to robotic Windows SAPI;
 * if all 3 attempts fail, throws a descriptive error to halt the execution cleanly.
 */
export async function synthesizeVoiceoverMp3(params: {
  storageKey: string;
  text: string;
  voice?: string;
  tone?: string;
  aspectRatio?: string;
}): Promise<{
  fullPath: string;
  bytes: number;
  durationSec: number;
  engine: string;
  cleanText: string;
  timedCaptions: TimedCaptionSegment[];
}> {
  const fullPath = resolveStoragePath(params.storageKey);
  const workDir = path.dirname(fullPath);
  await fs.mkdir(workDir, { recursive: true });

  const cleanText =
    sanitizeNarrationText(params.text) ||
    "Welcome to ContentOS automated media production.";

  const profile = pickNeuralVoiceAndProsody(params.tone, params.voice);
  const maxAttempts = 3;
  let lastError: unknown;
  let synthesized: { mp3Buffer: Buffer; wordTimings: WordTiming[] } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      synthesized = await attemptEdgeTtsOnce(cleanText, profile.voice);
      break;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const backoffMs = attempt * 1000;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  if (!synthesized) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Neural TTS synthesis failed after ${maxAttempts} attempts (${profile.voice}): ${reason}. Execution terminated to prevent robotic fallback.`
    );
  }

  const rawVoicePath = path.join(workDir, "voice_raw.mp3");
  await fs.writeFile(rawVoicePath, synthesized.mp3Buffer);

  // Studio broadcast mastering: warm chest EQ, crisp vocal presence, smooth dynamics
  await execFileAsync(ffmpegPath, [
    "-y",
    "-i", rawVoicePath,
    "-af", "highpass=f=75,equalizer=f=210:t=q:w=1.2:g=2.5,equalizer=f=3600:t=q:w=1.5:g=2.0,acompressor=threshold=-18dB:ratio=2.3:attack=12:release=160,alimiter=limit=0.95",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    fullPath,
  ]);
  await fs.unlink(rawVoicePath).catch(() => {});

  const stat = await fs.stat(fullPath);
  const totalDuration = await probeDurationSec(
    fullPath,
    Math.max(5, Math.ceil(cleanText.split(/\s+/).length / 2.5))
  );

  const isLandscape = params.aspectRatio === "16:9";
  const timedCaptions = buildCaptionCardsFromWordTimings(
    cleanText,
    synthesized.wordTimings,
    totalDuration,
    isLandscape ? 44 : 25,
    2
  );

  return {
    fullPath,
    bytes: stat.size,
    durationSec: totalDuration,
    engine: `msedge-tts (${profile.label}, ${synthesized.wordTimings.length} word-sync cues)`,
    cleanText,
    timedCaptions,
  };
}

function wrapTextLines(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = (cur + " " + w).trim();
    if (ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

function drawRoundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

async function fetchStockImages(topic: string, keywords: string[], count: number): Promise<Image[]> {
  const images: Image[] = [];
  const searchTerms = [topic, ...keywords.map((k) => k.replace(/^#/, ""))]
    .map((t) => t.replace(/[^a-zA-Z0-9\s]/g, " ").trim())
    .filter((t) => t.length >= 3);

  for (const term of searchTerms.slice(0, 3)) {
    if (images.length >= count) break;
    try {
      const url =
        "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=" +
        encodeURIComponent(`filetype:bitmap ${term}`) +
        "&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url&iiurlwidth=1280&format=json";
      const res = await fetch(url, {
        headers: { "User-Agent": "ContentOS-Studio/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        query?: { pages?: Record<string, { imageinfo?: Array<{ thumburl?: string; url?: string }> }> };
      };
      for (const page of Object.values(json.query?.pages ?? {})) {
        if (images.length >= count) break;
        const imgUrl = page.imageinfo?.[0]?.thumburl ?? page.imageinfo?.[0]?.url;
        if (!imgUrl || !/\.(jpe?g|png|webp)(\?|$)/i.test(imgUrl)) continue;
        const imgRes = await fetch(imgUrl, {
          headers: { "User-Agent": "ContentOS-Studio/1.0" },
          signal: AbortSignal.timeout(7000),
        });
        if (!imgRes.ok) continue;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.byteLength < 15_000) continue;
        const img = await loadImage(buf);
        images.push(img);
      }
    } catch {
      // continue
    }
  }
  return images;
}

interface StickmanRig {
  x: number;
  y: number;
  scale?: number;
  facing?: 1 | -1;
  leftShoulderAngle: number;
  leftElbowAngle: number;
  rightShoulderAngle: number;
  rightElbowAngle: number;
  leftHipAngle: number;
  leftKneeAngle: number;
  rightHipAngle: number;
  rightKneeAngle: number;
  torsoLean?: number;
  headTilt?: number;
  lookTargetX?: number;
  expression?: "happy" | "thinking" | "excited" | "focused";
  talking?: boolean;
  accentRightArm?: boolean;
}

export interface DynamicStoryboardBeat {
  beatSummary?: string;
  action?: string;
  position?: string;
  propType?: string;
  propTitle?: string;
  propMetrics?: string[];
}

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const clamped = Math.max(0, Math.min(1, x));
  return 1 + c3 * Math.pow(clamped - 1, 3) + c1 * Math.pow(clamped - 1, 2);
}

function easeOutCubic(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return 1 - Math.pow(1 - clamped, 3);
}

function isoProject(ix: number, iy: number, iz: number, ox: number, oy: number): { x: number; y: number } {
  const cos30 = 0.8660254;
  const sin30 = 0.5;
  return {
    x: ox + (ix - iy) * cos30,
    y: oy + (ix + iy) * sin30 - iz,
  };
}

function drawIsoBox(
  ctx: SKRSContext2D,
  ix: number,
  iy: number,
  iz: number,
  dx: number,
  dy: number,
  dz: number,
  ox: number,
  oy: number,
  topColor: string,
  leftColor: string,
  rightColor: string,
  strokeColor = "rgba(255,255,255,0.14)"
): void {
  const p000 = isoProject(ix, iy, iz, ox, oy);
  const p100 = isoProject(ix + dx, iy, iz, ox, oy);
  const p110 = isoProject(ix + dx, iy + dy, iz, ox, oy);
  const p010 = isoProject(ix, iy + dy, iz, ox, oy);

  const p001 = isoProject(ix, iy, iz + dz, ox, oy);
  const p101 = isoProject(ix + dx, iy, iz + dz, ox, oy);
  const p111 = isoProject(ix + dx, iy + dy, iz + dz, ox, oy);
  const p011 = isoProject(ix, iy + dy, iz + dz, ox, oy);

  // Left face (y + dy)
  ctx.fillStyle = leftColor;
  ctx.beginPath();
  ctx.moveTo(p010.x, p010.y);
  ctx.lineTo(p110.x, p110.y);
  ctx.lineTo(p111.x, p111.y);
  ctx.lineTo(p011.x, p011.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Right face (x + dx)
  ctx.fillStyle = rightColor;
  ctx.beginPath();
  ctx.moveTo(p100.x, p100.y);
  ctx.lineTo(p110.x, p110.y);
  ctx.lineTo(p111.x, p111.y);
  ctx.lineTo(p101.x, p101.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Top face (z + dz)
  ctx.fillStyle = topColor;
  ctx.beginPath();
  ctx.moveTo(p001.x, p001.y);
  ctx.lineTo(p101.x, p101.y);
  ctx.lineTo(p111.x, p111.y);
  ctx.lineTo(p011.x, p011.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawStatusPill(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  text: string,
  variant: "info" | "success" | "danger",
  pop: number
): void {
  const clean = text.toUpperCase().slice(0, 26);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(0.8 + 0.2 * pop, 0.8 + 0.2 * pop);

  ctx.font = "bold 22px 'Segoe UI', Arial, sans-serif";
  const textW = ctx.measureText(clean).width;
  const pillW = Math.max(210, textW + 68);
  const pillH = 48;

  drawRoundedRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 24);
  ctx.fillStyle =
    variant === "danger"
      ? "rgba(69, 10, 10, 0.92)"
      : variant === "success"
        ? "rgba(6, 78, 59, 0.92)"
        : "rgba(15, 23, 42, 0.94)";
  ctx.fill();

  const stroke =
    variant === "danger" ? "#f43f5e" : variant === "success" ? "#10b981" : "#475569";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Icon badge
  const dotX = -pillW / 2 + 26;
  ctx.fillStyle = variant === "danger" ? "#fb7185" : variant === "success" ? "#34d399" : "#f97316";
  ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  const glyph = variant === "danger" ? "?" : variant === "success" ? "?" : "?";
  ctx.fillText(glyph, dotX, 7);

  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "left";
  ctx.fillText(clean, dotX + 18, 7);
  ctx.restore();
}

/**
 * Renders 2.5D Isometric Tech Motion-Graphics Scenes (inspired by Branch Education / high-craft tech explainers):
 * - Deep obsidian-slate technical grid + warm/cool radial glow
 * - Top numbered chapter timeline stepper (01 .. 06 + NEXT)
 * - 3D Isometric Hardware Modules, Desk Capacity Grids, Server Towers, and Circuit Boards
 * - Floating Status Pill Badges (? / ? / ?)
 */
function renderIsometricTechScene(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  t: number,
  beat: DynamicStoryboardBeat,
  sceneIdx: number,
  sceneCount: number,
  sceneProgress: number
): void {
  const cx = w * 0.5;
  const cy = h * 0.50;
  const pop = easeOutBack(Math.min(1, sceneProgress * 3.4));
  const reveal = easeOutCubic(Math.min(1, sceneProgress * 2.2));

  // 1. Deep Obsidian-Slate Studio Backdrop + Subtle Grid
  const bg = ctx.createRadialGradient(cx, cy - 40, 60, cx, cy, h * 0.75);
  bg.addColorStop(0, "#0f172a");
  bg.addColorStop(0.55, "#070c16");
  bg.addColorStop(1, "#03060c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(148, 163, 184, 0.06)";
  ctx.lineWidth = 1.5;
  const gridStep = 56;
  for (let gx = 0; gx <= w; gx += gridStep) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h);
    ctx.stroke();
  }
  for (let gy = 0; gy <= h; gy += gridStep) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  // 2. Top Series / Chapter Timeline Bar (01 .. N + NEXT)
  const totalSteps = Math.min(6, Math.max(3, sceneCount));
  const topY = 92;
  const barStartX = 92;
  const barEndX = w - 165;
  const stepSpan = (barEndX - barStartX) / Math.max(1, totalSteps - 1);

  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(barStartX, topY);
  ctx.lineTo(barEndX, topY);
  ctx.stroke();

  const activeStep = Math.min(totalSteps - 1, sceneIdx);
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(barStartX, topY);
  ctx.lineTo(barStartX + stepSpan * (activeStep + sceneProgress * 0.8), topY);
  ctx.stroke();

  for (let i = 0; i < totalSteps; i++) {
    const sx = barStartX + i * stepSpan;
    const isCur = i === activeStep;
    const isPast = i < activeStep;
    ctx.fillStyle = isCur ? "#f97316" : isPast ? "#1e293b" : "#0f172a";
    ctx.beginPath();
    ctx.arc(sx, topY, isCur ? 18 : 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isCur ? "#fdba74" : isPast ? "#f97316" : "#475569";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = isCur ? "#090d16" : "#cbd5e1";
    ctx.font = "bold 14px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1).padStart(2, "0"), sx, topY + 5);
  }

  // NEXT pill on top right
  drawRoundedRect(ctx, w - 135, topY - 16, 86, 32, 16);
  ctx.fillStyle = "rgba(249, 115, 22, 0.16)";
  ctx.fill();
  ctx.strokeStyle = "rgba(249, 115, 22, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#fb923c";
  ctx.font = "bold 14px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("NEXT", w - 92, topY + 5);

  // 3. Floating Status Pill Badge above 3D Isometric Stage
  const propType = beat.propType || "comparison_bars";
  const metrics = beat.propMetrics && beat.propMetrics.length > 0 ? beat.propMetrics : ["SYSTEM A", "SYSTEM B", "OPTIMIZED"];
  const titleBadge = (beat.propTitle || beat.beatSummary || "ARCHITECTURE").toUpperCase();
  const variant: "info" | "success" | "danger" =
    propType === "comparison_bars" && sceneIdx % 2 === 1
      ? "danger"
      : propType === "trophy_badge" || propType === "speed_gauge"
        ? "success"
        : "info";

  drawStatusPill(ctx, cx, cy - 335, titleBadge, variant, pop);

  // 4. 2.5D Isometric Centerpiece Object (Changes per beat & propType!)
  const floatY = Math.sin(t * 2.6) * 7;
  const isoOx = cx;
  const isoOy = cy + 65 + floatY;

  ctx.save();
  ctx.translate(isoOx, isoOy);
  ctx.scale(0.84 + 0.16 * pop, 0.84 + 0.16 * pop);
  ctx.translate(-isoOx, -isoOy);

  if (propType === "parallel_grid" || propType === "comparison_bars") {
    // Isometric Desk / Memory Capacity Grid with 3D Stacked Workload Blocks!
    drawIsoBox(ctx, -180, -140, -18, 360, 280, 18, isoOx, isoOy, "#1e293b", "#0f172a", "#334155");

    // Subtle isometric slot grid lines
    ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
    ctx.lineWidth = 1.5;
    for (let gx = -180; gx <= 180; gx += 90) {
      const a = isoProject(gx, -140, 1, isoOx, isoOy);
      const b = isoProject(gx, 140, 1, isoOx, isoOy);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const blocks = [
      { ix: -155, iy: -115, dx: 135, dy: 105, dz: 56, top: "#38bdf8", left: "#0284c7", right: "#0369a1", lbl: metrics[0] || "CORE OS" },
      { ix: 15, iy: -115, dx: 140, dy: 105, dz: 68, top: "#fb923c", left: "#ea580c", right: "#c2410c", lbl: metrics[1] || "ACTIVE LOAD" },
      { ix: -155, iy: 15, dx: 135, dy: 105, dz: 52, top: "#a78bfa", left: "#7c3aed", right: "#6d28d9", lbl: metrics[2] || "CACHE" },
      { ix: 15, iy: 15, dx: 140, dy: 105, dz: 84, top: "#34d399", left: "#059669", right: "#047857", lbl: "THROUGHPUT" },
    ];

    blocks.forEach((b, idx) => {
      const blockPop = easeOutBack(Math.min(1, Math.max(0, (sceneProgress - idx * 0.14) * 3.5)));
      if (blockPop <= 0.02) return;
      const dropZ = (1 - blockPop) * 90;
      drawIsoBox(ctx, b.ix, b.iy, dropZ, b.dx, b.dy, b.dz * blockPop, isoOx, isoOy, b.top, b.left, b.right);

      const labelPos = isoProject(b.ix + b.dx * 0.5, b.iy + b.dy * 0.5, b.dz * blockPop + dropZ + 6, isoOx, isoOy);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 16px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(b.lbl.slice(0, 14).toUpperCase(), labelPos.x, labelPos.y);
    });
  } else if (propType === "flow_network" || propType === "blueprint_structure") {
    // Isometric Motherboard / Hardware Module with Gold Connector Pins & Glowing Traces!
    drawIsoBox(ctx, -210, -90, 0, 420, 180, 16, isoOx, isoOy, "#065f46", "#064e3b", "#047857", "#34d399");

    // Gold contact pins along bottom-right edge
    for (let pIdx = -190; pIdx <= 190; pIdx += 24) {
      drawIsoBox(ctx, pIdx, 90, -4, 14, 14, 8, isoOx, isoOy, "#fbbf24", "#d97706", "#b45309", "rgba(0,0,0,0.2)");
    }

    // 4 Black BGA Silicon Chips soldered on top
    [-145, -50, 45, 140].forEach((cxOff, idx) => {
      const chipH = 26 + (idx % 2) * 8;
      drawIsoBox(ctx, cxOff - 32, -45, 16, 64, 90, chipH, isoOx, isoOy, "#1e293b", "#090d16", "#0f172a", "#38bdf8");
    });

    // Glowing data pulse beam across the board
    const pulseX = -180 + ((t * 220) % 360);
    const beamPt = isoProject(pulseX, 0, 46, isoOx, isoOy);
    ctx.fillStyle = "#f97316";
    ctx.beginPath();
    ctx.arc(beamPt.x, beamPt.y, 10, 0, Math.PI * 2);
    ctx.fill();

    const badgePt = isoProject(0, 0, 75, isoOx, isoOy);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 28px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText((metrics[0] || "SILICON ENGINE").toUpperCase().slice(0, 18), badgePt.x, badgePt.y);
  } else {
    // Isometric 3D Data-Center / Performance Tower Array (growth_chart / speed_gauge / trophy_badge)
    drawIsoBox(ctx, -195, -135, -14, 390, 270, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#090d16");

    const towers = [
      { ix: -135, iy: -45, h: 75 * reveal, top: "#64748b", left: "#475569", right: "#334155", lbl: metrics[0] || "BASE" },
      { ix: -25, iy: -45, h: 145 * reveal, top: "#38bdf8", left: "#0284c7", right: "#0369a1", lbl: metrics[1] || "BOOST" },
      { ix: 85, iy: -45, h: 225 * reveal, top: "#fb923c", left: "#ea580c", right: "#c2410c", lbl: metrics[2] || "PEAK" },
    ];

    towers.forEach((tw, idx) => {
      const hSafe = Math.max(18, tw.h);
      drawIsoBox(ctx, tw.ix, tw.iy, 0, 72, 90, hSafe, isoOx, isoOy, tw.top, tw.left, tw.right);

      // Blinking server LEDs on front face
      for (let zLed = 22; zLed < hSafe - 16; zLed += 28) {
        const ledPt = isoProject(tw.ix + 24, tw.iy + 91, zLed, isoOx, isoOy);
        ctx.fillStyle = Math.sin(t * 8 + idx + zLed) > 0 ? "#4ade80" : "#22d3ee";
        ctx.beginPath();
        ctx.arc(ledPt.x, ledPt.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      const capPt = isoProject(tw.ix + 36, tw.iy + 45, hSafe + 22, isoOx, isoOy);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(tw.lbl.slice(0, 12).toUpperCase(), capPt.x, capPt.y);
    });
  }

  ctx.restore();
}

function drawCartoonOfficeEnv(ctx: SKRSContext2D, w: number, h: number, t: number): void {
  // Warm cream/sage office wall with clean cartoon ink lines
  ctx.fillStyle = "#dbe4e8";
  ctx.fillRect(0, 0, w, h);

  // Subtle wall wainscoting
  ctx.fillStyle = "#c5d3d9";
  ctx.fillRect(0, h * 0.56, w, h * 0.44);
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.56);
  ctx.lineTo(w, h * 0.56);
  ctx.stroke();

  // Office door on right
  const doorX = w * 0.76;
  const doorY = h * 0.24;
  ctx.fillStyle = "#94a3b8";
  ctx.fillRect(doorX, doorY, w * 0.20, h * 0.42);
  ctx.strokeRect(doorX, doorY, w * 0.20, h * 0.42);
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(doorX + 14, doorY + 14, w * 0.20 - 28, h * 0.42 - 14);
  ctx.strokeRect(doorX + 14, doorY + 14, w * 0.20 - 28, h * 0.42 - 14);

  // Animated Wall Clock
  const clockX = w * 0.34;
  const clockY = h * 0.22;
  ctx.fillStyle = "#475569";
  ctx.beginPath();
  ctx.arc(clockX, clockY, 76, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.beginPath();
  ctx.arc(clockX, clockY, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Clock ticks & moving hands
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(clockX + Math.cos(a) * 46, clockY + Math.sin(a) * 46);
    ctx.lineTo(clockX + Math.cos(a) * 56, clockY + Math.sin(a) * 56);
    ctx.stroke();
  }
  const minA = t * 1.4;
  const hrA = t * 0.12;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(clockX, clockY);
  ctx.lineTo(clockX + Math.cos(minA) * 46, clockY + Math.sin(minA) * 46);
  ctx.moveTo(clockX, clockY);
  ctx.lineTo(clockX + Math.cos(hrA) * 30, clockY + Math.sin(hrA) * 30);
  ctx.stroke();

  // Sticky notes pinned on wall
  const notes = [
    { x: w * 0.14, y: h * 0.34, c: "#fef08a", r: -0.06 },
    { x: w * 0.21, y: h * 0.35, c: "#bae6fd", r: 0.05 },
    { x: w * 0.17, y: h * 0.40, c: "#fbcfe8", r: -0.03 },
  ];
  notes.forEach((n) => {
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.rotate(n.r);
    ctx.fillStyle = n.c;
    ctx.fillRect(0, 0, 52, 52);
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, 52, 52);
    ctx.restore();
  });

  // Wooden Desk & Glowing Monitor on left
  const deskY = h * 0.62;
  ctx.fillStyle = "#9a7b5c";
  ctx.fillRect(0, deskY, w * 0.44, 28);
  ctx.lineWidth = 4;
  ctx.strokeRect(0, deskY, w * 0.44, 28);
  ctx.fillStyle = "#7c5e42";
  ctx.fillRect(0, deskY + 28, w * 0.40, h - deskY - 28);
  ctx.strokeRect(0, deskY + 28, w * 0.40, h - deskY - 28);

  // Computer Monitor
  ctx.fillStyle = "#334155";
  ctx.fillRect(w * 0.08, deskY - 165, 195, 130);
  ctx.strokeRect(w * 0.08, deskY - 165, 195, 130);
  ctx.fillStyle = "#e0f2fe";
  ctx.fillRect(w * 0.08 + 12, deskY - 153, 171, 106);
  ctx.fillStyle = "#38bdf8";
  ctx.fillRect(w * 0.08 + 22, deskY - 140, 90, 14);
  ctx.fillStyle = "#94a3b8";
  ctx.fillRect(w * 0.08 + 22, deskY - 116, 140, 10);
  ctx.fillRect(w * 0.08 + 22, deskY - 98, 120, 10);
  // Monitor Stand
  ctx.fillStyle = "#475569";
  ctx.fillRect(w * 0.08 + 82, deskY - 35, 30, 35);
  ctx.strokeRect(w * 0.08 + 82, deskY - 35, 30, 35);
}

function drawCartoonNightStreetEnv(ctx: SKRSContext2D, w: number, h: number, t: number): void {
  // Deep twilight sky with twinkling stars
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.72);
  sky.addColorStop(0, "#0f172a");
  sky.addColorStop(1, "#1e293b");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "#fef9c3";
  for (let i = 0; i < 24; i++) {
    const sx = ((i * 197) % (w - 40)) + 20;
    const sy = ((i * 113) % Math.floor(h * 0.36)) + 30;
    const r = 1.5 + (i % 3) * (0.6 + 0.4 * Math.sin(t * 3 + i));
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // City buildings silhouette with warm lit windows
  const buildings = [
    { x: 20, y: h * 0.28, bw: 240, bh: h * 0.44, c: "#273549" },
    { x: 240, y: h * 0.22, bw: 280, bh: h * 0.50, c: "#1e293b" },
    { x: 500, y: h * 0.31, bw: 260, bh: h * 0.41, c: "#334155" },
    { x: 740, y: h * 0.25, bw: 320, bh: h * 0.47, c: "#1e293b" },
  ];
  ctx.strokeStyle = "#090d16";
  ctx.lineWidth = 4;
  buildings.forEach((b, bi) => {
    ctx.fillStyle = b.c;
    ctx.fillRect(b.x, b.y, b.bw, b.bh);
    ctx.strokeRect(b.x, b.y, b.bw, b.bh);

    for (let wx = b.x + 28; wx < b.x + b.bw - 44; wx += 56) {
      for (let wy = b.y + 32; wy < b.y + b.bh - 80; wy += 64) {
        const lit = (wx + wy + bi) % 3 !== 0;
        ctx.fillStyle = lit ? "#fde047" : "#0f172a";
        ctx.fillRect(wx, wy, 28, 36);
        ctx.strokeRect(wx, wy, 28, 36);
      }
    }
  });

  // Sidewalk & Street
  ctx.fillStyle = "#475569";
  ctx.fillRect(0, h * 0.68, w, h * 0.32);
  ctx.strokeRect(0, h * 0.68, w, h * 0.32);

  // Warm Streetlight Pole + Volumetric Light Cone
  const poleX = w * 0.24;
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(poleX, h * 0.68);
  ctx.lineTo(poleX, h * 0.25);
  ctx.quadraticCurveTo(poleX, h * 0.21, poleX + 65, h * 0.22);
  ctx.stroke();

  const cone = ctx.createLinearGradient(poleX + 65, h * 0.23, poleX + 65, h * 0.72);
  cone.addColorStop(0, "rgba(254, 240, 138, 0.42)");
  cone.addColorStop(1, "rgba(254, 240, 138, 0.0)");
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(poleX + 45, h * 0.23);
  ctx.lineTo(poleX + 85, h * 0.23);
  ctx.lineTo(poleX + 260, h * 0.72);
  ctx.lineTo(poleX - 110, h * 0.72);
  ctx.closePath();
  ctx.fill();
}

function drawCartoonDayWindowEnv(ctx: SKRSContext2D, w: number, h: number, t: number): void {
  // Bright cartoon studio wall
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(0, 0, w, h);

  // Large Sunlight Window on upper right
  const winX = w * 0.44;
  const winY = h * 0.20;
  const winW = w * 0.44;
  const winH = h * 0.28;

  ctx.fillStyle = "#bae6fd";
  ctx.fillRect(winX, winY, winW, winH);

  // Glowing Sun + Soft Sunbeam Shafts
  const sunX = winX + winW * 0.72;
  const sunY = winY + winH * 0.35;
  ctx.fillStyle = "#fde047";
  ctx.beginPath();
  ctx.arc(sunX, sunY, 44 + Math.sin(t * 3) * 3, 0, Math.PI * 2);
  ctx.fill();

  // Green bushes outside window
  ctx.fillStyle = "#4ade80";
  ctx.beginPath();
  ctx.arc(winX + 60, winY + winH - 10, 55, Math.PI, 0);
  ctx.arc(winX + 145, winY + winH - 5, 65, Math.PI, 0);
  ctx.fill();

  // Window frame & mullions
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 8;
  ctx.strokeRect(winX, winY, winW, winH);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(winX + winW / 2, winY);
  ctx.lineTo(winX + winW / 2, winY + winH);
  ctx.moveTo(winX, winY + winH / 2);
  ctx.lineTo(winX + winW, winY + winH / 2);
  ctx.stroke();

  // Diagonal warm sunbeams across room
  const beam = ctx.createLinearGradient(winX, winY, winX - 180, winY + winH + 260);
  beam.addColorStop(0, "rgba(254, 249, 195, 0.38)");
  beam.addColorStop(1, "rgba(254, 249, 195, 0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(winX, winY + winH);
  ctx.lineTo(winX + winW, winY + winH);
  ctx.lineTo(winX + winW - 220, h * 0.76);
  ctx.lineTo(winX - 240, h * 0.76);
  ctx.closePath();
  ctx.fill();

  // Wooden floor
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(0, h * 0.66, w, h * 0.34);
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.66);
  ctx.lineTo(w, h * 0.66);
  ctx.stroke();
}

function drawSunburstFinaleEnv(ctx: SKRSContext2D, w: number, h: number, t: number): void {
  const cx = w * 0.5;
  const cy = h * 0.48;
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(0, 0, w, h);

  const rays = 18;
  const spin = t * 0.25;
  ctx.fillStyle = "#fde047";
  for (let i = 0; i < rays; i++) {
    const a1 = spin + (i / rays) * Math.PI * 2;
    const a2 = a1 + (Math.PI / rays);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a1) * h * 1.2, cy + Math.sin(a1) * h * 1.2);
    ctx.lineTo(cx + Math.cos(a2) * h * 1.2, cy + Math.sin(a2) * h * 1.2);
    ctx.closePath();
    ctx.fill();
  }
}

function drawStudioBackdrop(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  floorY: number,
  focalX: number,
  darkTheme: boolean
): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  if (darkTheme) {
    bg.addColorStop(0, "#050814");
    bg.addColorStop(0.55, "#0b1224");
    bg.addColorStop(1, "#060913");
  } else {
    bg.addColorStop(0, "#f8fafc");
    bg.addColorStop(0.62, "#eef2ff");
    bg.addColorStop(1, "#cbd5e1");
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = darkTheme ? "rgba(56, 189, 248, 0.14)" : "rgba(79, 70, 229, 0.11)";
  const step = 48;
  for (let gx = 48; gx < w - 32; gx += step) {
    for (let gy = 280; gy < floorY - 24; gy += step) {
      ctx.beginPath();
      ctx.arc(gx, gy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const spot = ctx.createRadialGradient(focalX, floorY - 240, 40, focalX, floorY - 240, 520);
  spot.addColorStop(0, darkTheme ? "rgba(56, 189, 248, 0.18)" : "rgba(255, 255, 255, 0.85)");
  spot.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, w, h);
}

function drawArticulatedStickman(ctx: SKRSContext2D, rig: StickmanRig, t: number): void {
  const sc = rig.scale ?? 1;
  const facing = rig.facing ?? 1;
  const lean = rig.torsoLean ?? 0;
  const breath = Math.sin(t * 3.4) * 3;

  ctx.save();
  ctx.translate(rig.x, rig.y);
  ctx.scale(sc * facing, sc);

  // Soft ground shadow
  ctx.fillStyle = "rgba(15, 23, 42, 0.24)";
  ctx.beginPath();
  ctx.ellipse(0, 218, 96, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  const hipX = 0;
  const hipY = 65;
  const torsoLen = 128 + breath;
  const shoulderX = Math.sin(lean) * torsoLen;
  const shoulderY = hipY - Math.cos(lean) * torsoLen;
  const headX = shoulderX + Math.sin(lean) * 66;
  const headY = shoulderY - Math.cos(lean) * 66;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const drawLimb = (
    ox: number,
    oy: number,
    upperLen: number,
    lowerLen: number,
    a1: number,
    a2: number,
    sleeveColor: string | null,
    width: number,
    isLeg = false
  ) => {
    const jx = ox + Math.sin(a1) * upperLen;
    const jy = oy + Math.cos(a1) * upperLen;
    const ex = jx + Math.sin(a1 + a2) * lowerLen;
    const ey = jy + Math.cos(a1 + a2) * lowerLen;

    // Inked limb
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(jx, jy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Cartoon shirt sleeve or trouser leg overlay
    if (sleeveColor) {
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = width + 10;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(isLeg ? ex : jx, isLeg ? ey : jy);
      ctx.stroke();

      ctx.strokeStyle = sleeveColor;
      ctx.lineWidth = width + 4;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(isLeg ? ex : jx, isLeg ? ey : jy);
      ctx.stroke();
    }

    if (isLeg) {
      // Cartoon Sneaker/Shoe
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.ellipse(ex + 12, ey + 4, 21, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // White Cartoon Gloved/Inked Hand
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(ex, ey, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  };

  // Back arm with blue shirt sleeve
  drawLimb(shoulderX, shoulderY + 12, 68, 64, rig.leftShoulderAngle, rig.leftElbowAngle, "#2563eb", 10, false);

  // Cartoon Trousers (Dark Slate Jeans)
  drawLimb(hipX, hipY, 76, 74, rig.leftHipAngle, rig.leftKneeAngle, "#1e293b", 12, true);
  drawLimb(hipX, hipY, 76, 74, rig.rightHipAngle, rig.rightKneeAngle, "#334155", 12, true);

  // Cartoon Collared Shirt Torso (Cobalt Blue with dark ink outline)
  ctx.save();
  ctx.translate(hipX, hipY);
  ctx.rotate(lean);
  drawRoundedRect(ctx, -26, -torsoLen, 52, torsoLen + 8, 16);
  ctx.fillStyle = "#3b82f6";
  ctx.fill();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 6;
  ctx.stroke();

  // Shirt Collar & Button Placket
  ctx.fillStyle = "#60a5fa";
  ctx.beginPath();
  ctx.moveTo(-16, -torsoLen);
  ctx.lineTo(0, -torsoLen + 22);
  ctx.lineTo(16, -torsoLen);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Front arm with blue shirt sleeve
  drawLimb(
    shoulderX,
    shoulderY + 12,
    70,
    66,
    rig.rightShoulderAngle,
    rig.rightElbowAngle,
    "#3b82f6",
    10,
    false
  );

  // Expressive Cartoon Head (Larger proportions like Lucky D. Stickman)
  ctx.save();
  ctx.translate(headX, headY);
  ctx.rotate((rig.headTilt ?? 0) + Math.sin(t * 5.2) * 0.03);

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(0, 0, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = "#0f172a";
  ctx.stroke();

  // Subtle side cheek shading
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, 51, 0.65 * Math.PI, 1.35 * Math.PI);
  ctx.stroke();

  // Large Expressive Cartoon Eyes (sclera + tracking pupils)
  const blink = Math.abs(Math.sin(t * 1.4)) > 0.985 ? 0.15 : 1;
  const pupilShift = rig.lookTargetX !== undefined ? Math.max(-4, Math.min(4, rig.lookTargetX)) : 3.5;

  [
    { ex: -10, ey: -6, rx: 13, ry: 16 },
    { ex: 22, ey: -6, rx: 13, ry: 16 },
  ].forEach((eye) => {
    ctx.save();
    ctx.translate(eye.ex, eye.ey);
    ctx.scale(1, blink);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 0, eye.rx, eye.ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(pupilShift, 0, 5.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(pupilShift + 1.8, -2, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Thick Expressive Eyebrows
  const expr = rig.expression ?? "happy";
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 6.5;
  if (expr === "thinking") {
    ctx.beginPath();
    ctx.moveTo(-24, -27);
    ctx.lineTo(-2, -22);
    ctx.moveTo(10, -28);
    ctx.lineTo(32, -35);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-23, -26);
    ctx.quadraticCurveTo(-10, -33, 2, -26);
    ctx.moveTo(10, -26);
    ctx.quadraticCurveTo(22, -33, 34, -26);
    ctx.stroke();
  }

  // Cartoon Lip-Sync Mouth
  if (rig.talking) {
    const open = 4.5 + Math.abs(Math.sin(t * 14.5)) * 10;
    ctx.fillStyle = "#991b1b";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(7, 23, 14, open, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (expr === "excited") {
    ctx.fillStyle = "#991b1b";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(7, 18, 17, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(7, 17, 14, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }

  ctx.restore();
  ctx.restore();
}

function drawDynamicProp(
  ctx: SKRSContext2D,
  propType: string,
  propTitle: string,
  metrics: string[],
  px: number,
  py: number,
  t: number,
  progress: number,
  darkTheme: boolean
): void {
  const entrance = easeOutBack(Math.min(1, progress * 3.2));
  const reveal = easeOutCubic(Math.min(1, progress * 2.2));
  const m0 = (metrics[0] || "PHASE 1").slice(0, 22);
  const m1 = (metrics[1] || "PHASE 2").slice(0, 22);
  const m2 = (metrics[2] || "RESULT").slice(0, 22);
  const title = (propTitle || "BREAKDOWN").toUpperCase().slice(0, 28);

  ctx.save();
  ctx.translate(px, py + Math.sin(t * 2.8) * 5);
  ctx.scale(0.84 + 0.16 * entrance, 0.84 + 0.16 * entrance);

  const cardW = 450;
  const cardH = 330;

  // Crisp Cartoon / Glass Card
  drawRoundedRect(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 24);
  ctx.fillStyle = darkTheme ? "rgba(15, 23, 42, 0.92)" : "#ffffff";
  ctx.fill();
  ctx.strokeStyle = darkTheme ? "#22d3ee" : "#0f172a";
  ctx.lineWidth = darkTheme ? 3.5 : 6;
  ctx.stroke();

  // Header bar inside prop board
  drawRoundedRect(ctx, -cardW / 2 + 16, -cardH / 2 + 16, cardW - 32, 42, 12);
  ctx.fillStyle = darkTheme ? "rgba(34, 211, 238, 0.14)" : "#3b82f6";
  ctx.fill();

  ctx.fillStyle = darkTheme ? "#22d3ee" : "#ffffff";
  ctx.font = "bold 19px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, 0, -cardH / 2 + 44);

  const pts = [
    { x: -150, y: 78, lbl: m0 },
    { x: 0, y: 14, lbl: m1 },
    { x: 150, y: -66, lbl: m2 },
  ];
  ctx.strokeStyle = darkTheme ? "#22d3ee" : "#2563eb";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (reveal > 0.25) ctx.lineTo(pts[1].x, pts[1].y);
  if (reveal > 0.65) ctx.lineTo(pts[2].x, pts[2].y);
  ctx.stroke();

  pts.forEach((pt, idx) => {
    if (reveal >= idx * 0.3) {
      ctx.fillStyle = idx === 2 ? "#22c55e" : "#f97316";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
      ctx.fill();
      if (!darkTheme) ctx.stroke();

      ctx.fillStyle = darkTheme ? "#e2e8f0" : "#0f172a";
      ctx.font = "bold 17px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(pt.lbl.slice(0, 14), pt.x, pt.y + 34);
    }
  });

  ctx.restore();
}

function renderDynamicStickmanScene(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  t: number,
  beat: DynamicStoryboardBeat,
  sceneIdx: number,
  sceneCount: number,
  sceneProgress: number
): void {
  const action = beat.action || "presenting_board";
  const pos = beat.position || (sceneIdx % 2 === 0 ? "left" : "right");
  const propType = beat.propType || "growth_chart";
  const propTitle = beat.propTitle || beat.beatSummary || "KEY CONCEPT";
  const propMetrics = beat.propMetrics && beat.propMetrics.length > 0 ? beat.propMetrics : ["BEFORE", "AFTER"];

  const isFinale = sceneIdx === sceneCount - 1 || action === "celebrating";

  // Cycle through rich cartoon environments across story beats (Office -> Night Street -> Sunny Room -> Sunburst Finale)
  if (isFinale) {
    drawSunburstFinaleEnv(ctx, w, h, t);
  } else if (sceneIdx % 3 === 0) {
    drawCartoonOfficeEnv(ctx, w, h, t);
  } else if (sceneIdx % 3 === 1) {
    drawCartoonNightStreetEnv(ctx, w, h, t);
  } else {
    drawCartoonDayWindowEnv(ctx, w, h, t);
  }

  const cx = w * 0.5;
  const cy = h * 0.52;

  let charX = cx - 235;
  let charY = cy;
  let facing: 1 | -1 = 1;
  let propX = cx + 195;
  let propY = cy - 45;

  if (isFinale) {
    charX = cx;
    charY = cy + 25;
  } else if (pos === "right") {
    charX = cx + 235;
    facing = -1;
    propX = cx - 195;
  } else if (pos === "traverse" || action === "walking_across") {
    charX = w * 0.24 + easeOutCubic(sceneProgress) * (w * 0.52);
    propX = cx;
    propY = cy - 260;
  }

  if (!isFinale) {
    drawDynamicProp(ctx, propType, propTitle, propMetrics, propX, propY, t, sceneProgress, false);
  }

  const stride = t * 8.5;
  let rig: StickmanRig = {
    x: charX,
    y: charY + Math.sin(t * 4.2) * 5,
    scale: isFinale ? 1.05 : 0.94,
    facing,
    lookTargetX: isFinale ? 0 : 3.5,
    torsoLean: 0.06,
    leftShoulderAngle: 0.35,
    leftElbowAngle: -0.35,
    rightShoulderAngle: -1.35 + Math.sin(t * 6.5) * 0.22,
    rightElbowAngle: -0.25,
    leftHipAngle: 0.18,
    leftKneeAngle: 0,
    rightHipAngle: -0.18,
    rightKneeAngle: 0,
    expression: isFinale ? "excited" : "happy",
    talking: true,
    accentRightArm: true,
  };

  if (action === "walking_across" && !isFinale) {
    rig = {
      ...rig,
      y: charY - Math.abs(Math.sin(stride)) * 13,
      torsoLean: 0.14,
      leftShoulderAngle: Math.sin(stride) * 0.65,
      leftElbowAngle: -0.45,
      rightShoulderAngle: -Math.sin(stride) * 0.65,
      rightElbowAngle: -0.55,
      leftHipAngle: -Math.sin(stride) * 0.58,
      leftKneeAngle: Math.max(0, Math.sin(stride) * 0.75),
      rightHipAngle: Math.sin(stride) * 0.58,
      rightKneeAngle: Math.max(0, -Math.sin(stride) * 0.75),
    };
  } else if (isFinale) {
    const jump = Math.abs(Math.sin(t * 5.2));
    rig = {
      ...rig,
      y: charY - jump * 42,
      leftShoulderAngle: -2.45 - jump * 0.2,
      rightShoulderAngle: -2.45 - jump * 0.2,
      leftHipAngle: 0.32 + jump * 0.2,
      leftKneeAngle: -0.35 * jump,
      rightHipAngle: -0.32 - jump * 0.2,
      rightKneeAngle: 0.35 * jump,
      expression: "excited",
    };
  }

  drawArticulatedStickman(ctx, rig, t);
}

function renderMinimalLineArtScene(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  t: number,
  beat: DynamicStoryboardBeat,
  sceneProgress: number
): void {
  drawStudioBackdrop(ctx, w, h, h * 0.68, w * 0.5, true);

  // Animated cyan oscilloscope waveform behind blueprint card
  ctx.strokeStyle = "rgba(34, 211, 238, 0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = 60; x <= w - 60; x += 14) {
    const y = h * 0.46 + Math.sin(x * 0.02 + t * 6) * 85 * Math.cos(x * 0.006 - t * 2);
    if (x === 60) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  drawDynamicProp(
    ctx,
    beat.propType || "blueprint_structure",
    beat.propTitle || beat.beatSummary || "ARCHITECTURE",
    beat.propMetrics || ["NODE A", "NODE B", "OUTPUT"],
    w * 0.5,
    h * 0.46,
    t,
    sceneProgress,
    true
  );
}

export async function renderVerticalVideoMp4(params: {
  videoStorageKey: string;
  audioStorageKey: string;
  channelName: string;
  title: string;
  hook: string;
  script: string;
  keywords?: string[];
  storyboard?: DynamicStoryboardBeat[];
  timedCaptions?: TimedCaptionSegment[];
  aspectRatio?: string;
  videoStyle?: VideoStyleId;
}): Promise<{ fullPath: string; bytes: number; durationSec: number; resolution: string; sceneCount: number; videoStyle: VideoStyleId; videoEncoder: string }> {
  const videoPath = resolveStoragePath(params.videoStorageKey);
  const audioPath = resolveStoragePath(params.audioStorageKey);
  const workDir = path.dirname(videoPath);
  await fs.mkdir(workDir, { recursive: true });

  const isLandscape = params.aspectRatio === "16:9";
  const width = isLandscape ? 1920 : 1080;
  const height = isLandscape ? 1080 : 1920;
  const resolution = `${width}x${height}`;
  const fps = 30;
  const style: VideoStyleId = params.videoStyle || "isometric_tech";

  const audioDuration = await probeDurationSec(audioPath, 15);
  const safeDuration = Math.max(5, audioDuration + 0.5);
  const totalFrames = Math.ceil(safeDuration * fps);

  const cleanTitle = sanitizeNarrationText(params.title) || params.channelName;
  const cleanScript = sanitizeNarrationText(params.script || params.hook);

  const syncedCaptions: TimedCaptionSegment[] =
    params.timedCaptions && params.timedCaptions.length > 0
      ? params.timedCaptions
      : buildCaptionCardsFromWordTimings(cleanScript, [], audioDuration, isLandscape ? 44 : 25, 2);

  const aiBeats: DynamicStoryboardBeat[] =
    params.storyboard && params.storyboard.length > 0
      ? params.storyboard
      : syncedCaptions.slice(0, 6).map((seg, idx) => {
          const actions = ["thinking", "walking_across", "directing_swarm", "presenting_board", "examining_lens", "celebrating"];
          const positions = ["left", "traverse", "left", "right", "left", "center"];
          const props = ["comparison_bars", "flow_network", "parallel_grid", "growth_chart", "magnifying_lens", "trophy_badge"];
          const words = seg.spokenText.split(/\s+/).filter((w) => w.length > 3);
          return {
            beatSummary: seg.lines[0] || cleanTitle,
            action: actions[idx % actions.length],
            position: positions[idx % positions.length],
            propType: props[idx % props.length],
            propTitle: (words.slice(0, 3).join(" ") || cleanTitle).toUpperCase(),
            propMetrics: words.slice(0, 3).map((w) => w.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()),
          };
        });

  const sceneCount = aiBeats.length;
  const sceneDur = safeDuration / sceneCount;

  // Mix subtle UI micro-pop foley on every scene transition beneath the voiceover
  const foleyAudioPath = path.join(workDir, "voice_with_foley.m4a");
  let finalAudioForMux = audioPath;
  try {
    const popDelays = Array.from({ length: sceneCount }, (_, idx) => Math.round(idx * sceneDur * 1000));
    const popFilters = popDelays.map(
      (ms, idx) =>
        `sine=frequency=680:duration=0.055,afade=t=out:st=0.015:d=0.04,volume=0.14,adelay=${ms}|${ms}[p${idx}]`
    );
    const mixInputs = ["[0:a]", ...popDelays.map((_, idx) => `[p${idx}]`)].join("");
    const filterComplex = `${popFilters.join(";")};${mixInputs}amix=inputs=${popDelays.length + 1}:duration=first:normalize=0[aout]`;

    await execFileAsync(ffmpegPath, [
      "-y",
      "-i", audioPath,
      "-filter_complex", filterComplex,
      "-map", "[aout]",
      "-c:a", "aac",
      "-b:a", "192k",
      foleyAudioPath,
    ]);
    finalAudioForMux = foleyAudioPath;
  } catch {
    finalAudioForMux = audioPath;
  }

  const stockImages =
    style === "stock_ken_burns"
      ? await fetchStockImages(cleanTitle, params.keywords ?? [], sceneCount)
      : [];

  const useNvenc = await isNvencAvailable();
  const videoCodecArgs = useNvenc
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "20"]
    : ["-c:v", "libx264", "-preset", "fast", "-crf", "19"];

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const ffmpegProc = spawn(
    ffmpegPath,
    [
      "-y",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-s", resolution,
      "-r", String(fps),
      "-i", "pipe:0",
      "-i", finalAudioForMux,
      ...videoCodecArgs,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", safeDuration.toFixed(2),
      "-movflags", "+faststart",
      videoPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );

  let ffmpegStderr = "";
  ffmpegProc.stderr?.on("data", (chunk: Buffer) => {
    ffmpegStderr += chunk.toString();
  });

  const isIsometric = style === "isometric_tech";
  const isCartoonStickman = style === "stickman_explainer";
  const accentHex = isIsometric
    ? "#f97316"
    : isCartoonStickman
      ? "#22c55e"
      : style === "minimal_line_art" || style === "tech_hud_blueprint"
        ? "#22d3ee"
        : "#6366f1";

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const sceneIdx = Math.min(sceneCount - 1, Math.floor(t / sceneDur));
    const sceneProgress = (t - sceneIdx * sceneDur) / sceneDur;
    const activeBeat = aiBeats[sceneIdx]!;

    if (isIsometric) {
      renderIsometricTechScene(ctx, width, height, t, activeBeat, sceneIdx, sceneCount, sceneProgress);
    } else if (isCartoonStickman) {
      renderDynamicStickmanScene(ctx, width, height, t, activeBeat, sceneIdx, sceneCount, sceneProgress);
    } else if (style === "minimal_line_art") {
      renderMinimalLineArtScene(ctx, width, height, t, activeBeat, sceneProgress);
    } else if (style === "stock_ken_burns" && stockImages.length > 0) {
      const img = stockImages[sceneIdx % stockImages.length];
      const zoom = sceneIdx % 2 === 0 ? 1.0 + sceneProgress * 0.12 : 1.12 - sceneProgress * 0.12;
      const scale = Math.max(width / img.width, height / img.height) * zoom;
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);

      const vig = ctx.createLinearGradient(0, 0, 0, height);
      vig.addColorStop(0, "rgba(9, 9, 11, 0.78)");
      vig.addColorStop(0.45, "rgba(9, 9, 11, 0.30)");
      vig.addColorStop(1, "rgba(9, 9, 11, 0.88)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);
    } else {
      drawStudioBackdrop(ctx, width, height, height * 0.68, width * 0.5, true);

      // Animated Concentric Telemetry Rings for Kinetic Typography & HUD styles
      for (let rIdx = 1; rIdx <= 3; rIdx++) {
        ctx.strokeStyle = `rgba(99, 102, 241, ${0.18 - rIdx * 0.04})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(width * 0.5, height * 0.46, rIdx * 135 + Math.sin(t * 3 + rIdx) * 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (style !== "kinetic_typography") {
        drawDynamicProp(
          ctx,
          activeBeat.propType || "comparison_bars",
          activeBeat.propTitle || cleanTitle,
          activeBeat.propMetrics || ["DATA A", "DATA B"],
          width * 0.5,
          height * 0.46,
          t,
          sceneProgress,
          true
        );
      }
    }

    // Top Header Card (for non-isometric & non-cartoon styles)
    if (!isIsometric && !isCartoonStickman) {
      const headerH = isLandscape ? 155 : 235;
      drawRoundedRect(ctx, 44, 44, width - 88, headerH, 24);
      ctx.fillStyle = "rgba(9, 9, 11, 0.82)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#818cf8";
      ctx.font = `bold ${isLandscape ? 24 : 30}px 'Segoe UI', Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(params.channelName.toUpperCase(), 76, 92);

      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${isLandscape ? 38 : 44}px 'Segoe UI', Arial, sans-serif`;
      const titleLines = wrapTextLines(ctx, cleanTitle, width - 160, 2);
      titleLines.forEach((line, idx) => {
        ctx.fillText(line, 76, (isLandscape ? 142 : 154) + idx * (isLandscape ? 46 : 54));
      });
    }

    // High-Retention Word-by-Word Karaoke Subtitles across ALL styles!
    const activeCaption =
      syncedCaptions.find((seg) => t >= seg.startSec && t < seg.endSec) ??
      syncedCaptions[syncedCaptions.length - 1]!;
    const pageLines = activeCaption?.lines ?? [];
    const capAge = Math.max(0, t - (activeCaption?.startSec ?? 0));
    const capDur = Math.max(0.25, (activeCaption?.endSec ?? safeDuration) - (activeCaption?.startSec ?? 0));

    const capFontSize = style === "kinetic_typography" ? 64 : isLandscape ? 46 : 56;
    ctx.font = `900 ${capFontSize}px 'Segoe UI', Arial, sans-serif`;
    const lineHeight = capFontSize + 22;
    const baseY = style === "kinetic_typography"
      ? height * 0.46
      : isLandscape ? 830 : 1495;

    const allWords = pageLines.join(" ").split(/\s+/).filter(Boolean);
    let activeWordGlobalIdx = Math.min(
      allWords.length - 1,
      Math.floor((capAge / capDur) * allWords.length)
    );
    if (activeCaption?.words && activeCaption.words.length > 0) {
      const foundIdx = activeCaption.words.findIndex((wt) => t >= wt.startSec && t <= wt.endSec + 0.08);
      if (foundIdx !== -1) activeWordGlobalIdx = foundIdx;
    }

    let wordCounter = 0;
    pageLines.forEach((line, lIdx) => {
      const displayLine = isCartoonStickman ? line.toUpperCase() : line;
      const lineWords = displayLine.split(/\s+/).filter(Boolean);
      const widths = lineWords.map((w) => ctx.measureText(w + " ").width);
      const totalLineW = widths.reduce((a, b) => a + b, 0);
      let drawX = (width - totalLineW) / 2;
      const drawY = baseY + lIdx * lineHeight;

      lineWords.forEach((word, wIdx) => {
        const isHighlighted = wordCounter === activeWordGlobalIdx;
        ctx.textAlign = "left";

        if (isCartoonStickman) {
          // Comic-Book Heavy Black Ink Outline + Vibrant Emerald/Gold Highlight
          ctx.lineJoin = "round";
          ctx.strokeStyle = "#090d16";
          ctx.lineWidth = 11;
          ctx.strokeText(word, drawX, drawY);
          ctx.fillStyle = isHighlighted ? "#22c55e" : "#ffffff";
          ctx.fillText(word, drawX, drawY);
        } else {
          ctx.shadowColor = "rgba(0, 0, 0, 0.88)";
          ctx.shadowBlur = 14;
          ctx.fillStyle = isHighlighted ? accentHex : "#f8fafc";
          ctx.fillText(word, drawX, drawY);
          ctx.shadowBlur = 0;
        }

        drawX += widths[wIdx]!;
        wordCounter++;
      });
    });

    // Bottom Timeline Progress Bar
    const barY = height - 76;
    const barW = width - 96;
    drawRoundedRect(ctx, 48, barY, barW, 10, 5);
    ctx.fillStyle = "rgba(148, 163, 184, 0.24)";
    ctx.fill();

    const fillW = Math.max(10, barW * Math.min(1, t / safeDuration));
    drawRoundedRect(ctx, 48, barY, fillW, 10, 5);
    ctx.fillStyle = accentHex;
    ctx.fill();

    const frameBuf = Buffer.from(ctx.getImageData(0, 0, width, height).data.buffer);
    if (!ffmpegProc.stdin!.write(frameBuf)) {
      await new Promise<void>((resolve) => ffmpegProc.stdin!.once("drain", resolve));
    }
  }

  ffmpegProc.stdin!.end();
  await new Promise<void>((resolve, reject) => {
    ffmpegProc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${ffmpegStderr.slice(-800)}`));
    });
    ffmpegProc.on("error", reject);
  });

  if (finalAudioForMux !== audioPath) {
    await fs.unlink(foleyAudioPath).catch(() => {});
  }

  const stat = await fs.stat(videoPath);
  return {
    fullPath: videoPath,
    bytes: stat.size,
    durationSec: Number(safeDuration.toFixed(2)),
    resolution,
    sceneCount,
    videoStyle: style,
    videoEncoder: useNvenc ? "h264_nvenc (RTX GPU)" : "libx264 (CPU)",
  };
}
