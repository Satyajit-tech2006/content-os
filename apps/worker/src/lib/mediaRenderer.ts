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
  | "isometric_tech"
  | "stickman_explainer"
  | "minimal_line_art"
  | "phonk_montage_edit"
  | "stock_ken_burns"
  | "product_review_showcase"
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
  rate?: string;
  pitch?: string;
} {
  const raw = (explicitVoice || tone || "").toLowerCase();
  if (raw.includes("hindi_kabir") || raw.includes("hi-in-madhurneural:energetic") || raw.includes("kabir")) {
    return {
      voice: "hi-IN-MadhurNeural",
      label: "Kabir ? Hindi Energetic Male (hi-IN-MadhurNeural)",
      rate: "+10%",
      pitch: "+2Hz",
    };
  }
  if (raw.includes("hindi_kavya") || raw.includes("hi-in-swaraneural:calm") || raw.includes("kavya")) {
    return {
      voice: "hi-IN-SwaraNeural",
      label: "Kavya ? Hindi Calm Documentary (hi-IN-SwaraNeural)",
      rate: "-4%",
      pitch: "-1Hz",
    };
  }
  if (raw.includes("hindi_swara") || raw.includes("hi-in-swaraneural") || raw.includes("swara")) {
    return {
      voice: "hi-IN-SwaraNeural",
      label: "Swara ? Hindi Female Storyteller (hi-IN-SwaraNeural)",
      rate: "+2%",
    };
  }
  if (raw.includes("hindi_madhur") || raw.includes("hi-in-madhurneural") || raw.includes("madhur") || raw.includes("hindi")) {
    return {
      voice: "hi-IN-MadhurNeural",
      label: "Madhur ? Hindi Male Explainer (hi-IN-MadhurNeural)",
      rate: "+3%",
    };
  }
  if (explicitVoice) {
    return { voice: explicitVoice.split(":")[0]!, label: explicitVoice };
  }
  if (/energetic|creator|hype|gaming|fast|bold|punchy|guy/.test(raw)) {
    return {
      voice: "en-US-GuyNeural",
      label: "Guy Neural (Energetic Creator)",
    };
  }
  if (/warm|story|teller|calm|documentary|cinematic|aria/.test(raw)) {
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
  const countSpokenTokens = (str: string): number =>
    str
      .split(/[\s\-??/]+/)
      .map((t) => t.replace(/[^a-zA-Z0-9']/g, ""))
      .filter(Boolean).length;
  const rawWords = cleanText.split(/\s+/).filter(Boolean);
  const totalSpokenTokens = countSpokenTokens(cleanText);
  if (rawWords.length === 0) {
    return [{ lines: [cleanText.slice(0, maxCharsPerLine)], spokenText: cleanText, startSec: 0, endSec: totalDurationSec }];
  }

  // Build non-overlapping lines first, then group into maxLinesPerCard cards cleanly (zero duplicate lines)
  const allLines: Array<{ text: string; wordCount: number; endSentence: boolean }> = [];
  let curLine = "";
  let curWords = 0;

  for (const w of rawWords) {
    const candidate = curLine ? `${curLine} ${w}` : w;
    if (candidate.length <= maxCharsPerLine) {
      curLine = candidate;
      curWords++;
    } else {
      if (curLine) {
        allLines.push({ text: curLine, wordCount: countSpokenTokens(curLine), endSentence: /[.!?]$/.test(curLine) });
      }
      curLine = w;
      curWords = 1;
    }
    if (/[.!?]$/.test(curLine)) {
      allLines.push({ text: curLine, wordCount: countSpokenTokens(curLine), endSentence: true });
      curLine = "";
      curWords = 0;
    }
  }
  if (curLine) {
    allLines.push({ text: curLine, wordCount: countSpokenTokens(curLine), endSentence: false });
  }

  const cards: Array<{ lines: string[]; spokenText: string; wordCount: number }> = [];
  for (let i = 0; i < allLines.length; i++) {
    const first = allLines[i]!;
    if (!first.endSentence && maxLinesPerCard >= 2 && i + 1 < allLines.length) {
      const second = allLines[i + 1]!;
      cards.push({
        lines: [first.text, second.text],
        spokenText: `${first.text} ${second.text}`,
        wordCount: first.wordCount + second.wordCount,
      });
      i++;
    } else {
      cards.push({
        lines: [first.text],
        spokenText: first.text,
        wordCount: first.wordCount,
      });
    }
  }

  // Align each card directly to EdgeTTS WordBoundary timestamps
  if (wordTimings.length >= Math.max(3, Math.floor(totalSpokenTokens * 0.45))) {
    let wCursor = 0;
    return cards.map((card, idx) => {
      const startIdx = Math.min(wordTimings.length - 1, wCursor);
      const endIdx = Math.min(wordTimings.length - 1, wCursor + Math.max(1, card.wordCount) - 1);
      const sliceWords = wordTimings.slice(startIdx, endIdx + 1);
      wCursor += card.wordCount;

      const nextStartIdx = Math.min(wordTimings.length - 1, wCursor);
      const startSec = idx === 0 ? Math.max(0, wordTimings[0]!.startSec - 0.05) : wordTimings[startIdx]!.startSec;
      const endSec =
        idx === cards.length - 1
          ? totalDurationSec
          : Math.max(startSec + 0.25, wordTimings[nextStartIdx]?.startSec ?? wordTimings[endIdx]!.endSec);

      return {
        lines: card.lines,
        spokenText: card.spokenText,
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        words: sliceWords,
      };
    });
  }

  // Fallback proportional timing
  const totalWords = cards.reduce((acc, c) => acc + Math.max(1, c.wordCount), 0);
  let cursor = 0;
  return cards.map((card, idx) => {
    const dur = (Math.max(1, card.wordCount) / totalWords) * totalDurationSec;
    const out: TimedCaptionSegment = {
      lines: card.lines,
      spokenText: card.spokenText,
      startSec: Number(cursor.toFixed(3)),
      endSec: idx === cards.length - 1 ? totalDurationSec : Number((cursor + dur).toFixed(3)),
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
function splitTextIntoTtsChunks(text: string, maxChars = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const rawSent of sentences) {
    const sent = rawSent.trim();
    if (!sent) continue;
    if ((current + " " + sent).trim().length <= maxChars) {
      current = (current + " " + sent).trim();
    } else {
      if (current) chunks.push(current);
      if (sent.length <= maxChars) {
        current = sent;
      } else {
        // Split extra-long run-on sentences cleanly on commas or spaces
        const words = sent.split(/\s+/);
        let part = "";
        for (const w of words) {
          if ((part + " " + w).trim().length <= maxChars) {
            part = (part + " " + w).trim();
          } else {
            if (part) chunks.push(part);
            part = w;
          }
        }
        current = part;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

export async function synthesizeVoiceoverMp3(params: {
  storageKey: string;
  text: string;
  tone?: string;
  voice?: string;
  aspectRatio?: string;
}): Promise<{
  fullPath: string;
  bytes: number;
  durationSec: number;
  engine: string;
  timedCaptions: TimedCaptionSegment[];
}> {
  const fullPath = resolveStoragePath(params.storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  const cleanText = sanitizeNarrationText(params.text) || "Welcome to our channel.";
  const { voice, label } = pickNeuralVoiceAndProsody(params.tone, params.voice);
  const chunks = splitTextIntoTtsChunks(cleanText, 220);

  const chunkPaths: string[] = [];
  const allWordTimings: WordTiming[] = [];
  let cumulativeOffsetSec = 0;

  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const chunkText = chunks[cIdx]!;
    let chunkResult: { mp3Buffer: Buffer; wordTimings: WordTiming[] } | null = null;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= 7; attempt++) {
      try {
        chunkResult = await attemptEdgeTtsOnce(chunkText, voice);
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
    }

    if (!chunkResult) {
      for (const cp of chunkPaths) await fs.unlink(cp).catch(() => {});
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(
        `Neural TTS synthesis failed on chunk ${cIdx + 1}/${chunks.length} after 7 attempts (${voice}): ${msg}. Execution terminated to prevent robotic fallback.`
      );
    }

    // Re-encode each chunk cleanly (stripping raw MP3 Xing/ID3 header padding) so concat duration matches spoken audio 1:1
    const rawChunkPath = `${fullPath}.raw_${cIdx}.mp3`;
    const cleanChunkPath = `${fullPath}.chunk_${cIdx}.mp3`;
    await fs.writeFile(rawChunkPath, chunkResult.mp3Buffer);
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i", rawChunkPath,
      "-af", "aresample=async=1:first_pts=0",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      cleanChunkPath,
    ]);
    await fs.unlink(rawChunkPath).catch(() => {});
    chunkPaths.push(cleanChunkPath);

    const chunkDurSec = await probeDurationSec(
      cleanChunkPath,
      Math.max(1.2, chunkText.split(/\s+/).length * 0.36)
    );

    for (const wt of chunkResult.wordTimings) {
      allWordTimings.push({
        word: wt.word,
        startSec: Number((wt.startSec + cumulativeOffsetSec).toFixed(3)),
        endSec: Number((wt.endSec + cumulativeOffsetSec).toFixed(3)),
      });
    }

    cumulativeOffsetSec += chunkDurSec;
    if (cIdx < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  if (chunkPaths.length === 1) {
    await fs.rename(chunkPaths[0]!, fullPath);
  } else {
    const concatListPath = `${fullPath}.concat.txt`;
    const listBody = chunkPaths.map((cp) => `file '${cp.replace(/\\/g, "/")}'`).join("\n");
    await fs.writeFile(concatListPath, listBody, "utf8");
    await execFileAsync(ffmpegPath, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-af", "aresample=async=1:first_pts=0",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      fullPath,
    ]);
    await fs.unlink(concatListPath).catch(() => {});
    for (const cp of chunkPaths) await fs.unlink(cp).catch(() => {});
  }

  const stat = await fs.stat(fullPath);
  const durationSec = await probeDurationSec(
    fullPath,
    Math.max(5, Math.round(cleanText.split(/\s+/).length * 0.38))
  );

  const isLandscape = params.aspectRatio === "16:9";
  const timedCaptions = buildCaptionCardsFromWordTimings(
    cleanText,
    allWordTimings,
    durationSec,
    isLandscape ? 44 : 25,
    2
  );

  return {
    fullPath,
    bytes: stat.size,
    durationSec,
    engine: `msedge-tts (${label}, ${chunks.length} chunks, ${allWordTimings.length} word-sync cues)`,
    timedCaptions,
  };
}

function drawRoundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapTextLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = (current + " " + w).trim();
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (lines.length >= maxLines) return lines;
      current = w;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
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

function drawIsoPillLabel(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  rawText: string,
  accent = "#38bdf8"
): void {
  const words = rawText.trim().toUpperCase().split(/\s+/).filter(Boolean);
  let label = "";
  for (const w of words) {
    const next = label ? `${label} ${w}` : w;
    if (next.length <= 15) label = next;
    else break;
  }
  if (!label) label = rawText.toUpperCase().slice(0, 14);

  ctx.save();
  ctx.font = "900 14px 'Segoe UI', Arial, sans-serif";
  const tw = ctx.measureText(label).width;
  const pw = tw + 22;
  const ph = 26;

  drawRoundedRect(ctx, x - pw / 2, y - ph + 6, pw, ph, 8);
  ctx.fillStyle = "rgba(9, 13, 22, 0.88)";
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y);
  ctx.restore();
}

function drawStatusPill(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  text: string,
  variant: "info" | "success" | "danger",
  pop: number
): void {
  const clean = text.toUpperCase().slice(0, 28);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(0.84 + 0.16 * pop, 0.84 + 0.16 * pop);

  ctx.font = "900 22px 'Segoe UI', Arial, sans-serif";
  const textW = ctx.measureText(clean).width;
  const pillW = Math.max(240, textW + 84);
  const pillH = 54;

  // Soft outer glow
  ctx.shadowColor =
    variant === "danger"
      ? "rgba(244, 63, 94, 0.35)"
      : variant === "success"
        ? "rgba(16, 185, 129, 0.35)"
        : "rgba(249, 115, 22, 0.28)";
  ctx.shadowBlur = 18;

  drawRoundedRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 27);
  ctx.fillStyle =
    variant === "danger"
      ? "rgba(69, 10, 10, 0.94)"
      : variant === "success"
        ? "rgba(6, 78, 59, 0.94)"
        : "rgba(15, 23, 42, 0.96)";
  ctx.fill();
  ctx.shadowBlur = 0;

  const stroke =
    variant === "danger" ? "#f43f5e" : variant === "success" ? "#10b981" : "#f97316";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Crisp vector icon badge (never relies on missing font glyphs)
  const dotX = -pillW / 2 + 30;
  ctx.fillStyle = stroke;
  ctx.beginPath();
  ctx.arc(dotX, 0, 13, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#090d16";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (variant === "success") {
    ctx.beginPath();
    ctx.moveTo(dotX - 6, 0);
    ctx.lineTo(dotX - 1, 5);
    ctx.lineTo(dotX + 6, -5);
    ctx.stroke();
  } else if (variant === "danger") {
    ctx.beginPath();
    ctx.moveTo(dotX, -6);
    ctx.lineTo(dotX, 2);
    ctx.moveTo(dotX, 6);
    ctx.lineTo(dotX, 6.5);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#090d16";
    ctx.beginPath();
    ctx.moveTo(dotX, -6);
    ctx.lineTo(dotX + 6, 0);
    ctx.lineTo(dotX, 6);
    ctx.lineTo(dotX - 6, 0);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "left";
  ctx.fillText(clean, dotX + 22, 8);
  ctx.restore();
}

type IsoTopicTheme =
  | "aviation_space"
  | "maritime_rail"
  | "urban_architecture"
  | "wildlife_ecology"
  | "civic_governance"
  | "cold_chain"
  | "finance"
  | "bio_science"
  | "energy"
  | "retail"
  | "tech_systems";

type IsoArchetype =
  | "universal_vehicle"
  | "universal_building"
  | "wildlife_sanctuary"
  | "polling_station"
  | "document_printer"
  | "secure_vault"
  | "cooling_chamber"
  | "reefer_transit"
  | "atmosphere_dome"
  | "telemetry_beacon"
  | "conveyor_sorter"
  | "value_pillars"
  | "core_cutaway"
  | "orbital_network";

type IsoVehicleKind = "aircraft" | "train" | "ship" | "rocket" | "car" | "truck";
type IsoBuildingKind = "skyscraper" | "factory" | "hospital" | "bank" | "school" | "residential";

const ALL_ISO_ARCHETYPES: IsoArchetype[] = [
  "universal_vehicle",
  "universal_building",
  "wildlife_sanctuary",
  "polling_station",
  "document_printer",
  "secure_vault",
  "telemetry_beacon",
  "value_pillars",
  "cooling_chamber",
  "reefer_transit",
  "atmosphere_dome",
  "conveyor_sorter",
  "core_cutaway",
  "orbital_network",
];

function detectTopicTheme(fullText: string): IsoTopicTheme {
  const s = fullText.toLowerCase();
  if (/airplane|aircraft|flight|jet|airline|airport|rocket|space|satellite|orbit|isro|nasa|launch|drone|aviation/.test(s)) {
    return "aviation_space";
  }
  if (/train|railway|metro|bullet train|locomotive|ship|vessel|cargo ship|port|ocean|maritime|submarine|highway|traffic|ev|car|vehicle/.test(s)) {
    return "maritime_rail";
  }
  if (/skyscraper|building|city|urban|architecture|hospital|clinic|school|university|college|factory|plant|house|apartment|real estate|bridge|construction/.test(s)) {
    return "urban_architecture";
  }
  if (/tiger|lion|leopard|wildlife|animal|forest|ranger|sanctuary|reserve|species|habitat|livestock|elephant|wolf|bear|dog|cat|bird|safari|collar|poach|relocat/.test(s)) {
    return "wildlife_ecology";
  }
  if (/vote|voter|election|ballot|polling|booth|citizen|democra|constituenc|campaign|parliament|senate|government|civic|vvpat|strongroom/.test(s)) {
    return "civic_governance";
  }
  if (/strawberr|fruit|food|harvest|cold|cool|reefer|refrigerat|spoil|fresh|farm|crop|perish|dairy|meat|coffee|tea/.test(s)) {
    return "cold_chain";
  }
  if (/rupee|\u20b9|\$|price|margin|profit|cost|revenue|crore|lakh|tax|money|econom|wealth|invest|bank|stock|market/.test(s)) {
    return "finance";
  }
  if (/cell|brain|dna|protein|virus|med|health|heart|sleep|muscle|bio|drug|patient/.test(s)) {
    return "bio_science";
  }
  if (/solar|battery|grid|power|energy|lithium|wind|nuclear|carbon|climate|fuel|hydrogen/.test(s)) {
    return "energy";
  }
  if (/store|shop|retail|brand|customer|cafe|restaurant|ecommerce|delivery|packaging|consumer/.test(s)) {
    return "retail";
  }
  return "tech_systems";
}

function detectVehicleKind(text: string): IsoVehicleKind | null {
  const s = text.toLowerCase();
  if (/rocket|spacecraft|launch|booster|orbit|isro|nasa|starship/.test(s)) return "rocket";
  if (/airplane|aircraft|jet|plane|flight|airline|airport|boeing|airbus|fighter/.test(s)) return "aircraft";
  if (/train|railway|metro|bullet train|locomotive|vande bharat|rail|subway/.test(s)) return "train";
  if (/ship|vessel|boat|ferry|port|ocean|container|maritime|submarine|navy/.test(s)) return "ship";
  if (/car|ev|electric vehicle|tesla|taxi|sedan|suv|automobile|traffic/.test(s)) return "car";
  if (/truck|freight|reefer|lorry|cargo|van|delivery/.test(s)) return "truck";
  return null;
}

function detectBuildingKind(text: string): IsoBuildingKind | null {
  const s = text.toLowerCase();
  if (/hospital|clinic|medical|icu|doctor|patient|emergency|pharma/.test(s)) return "hospital";
  if (/factory|plant|manufactur|refinery|power plant|industrial|warehouse|assembly/.test(s)) return "factory";
  if (/bank|treasury|mint|vault|reserve|exchange|wall street|finance/.test(s)) return "bank";
  if (/school|university|college|campus|classroom|student|academy|courthouse|capitol/.test(s)) return "school";
  if (/house|home|apartment|residential|housing|villa|hotel|neighborhood/.test(s)) return "residential";
  if (/skyscraper|tower|headquarters|office|city|urban|building|architecture|real estate/.test(s)) return "skyscraper";
  return null;
}

function hasHumanActivity(text: string): boolean {
  return /people|person|voter|citizen|crowd|queue|line|agent|officer|worker|customer|patient|user|human|team|staff|student|doctor|public|booth|passenger/.test(
    text.toLowerCase()
  );
}

function hasAnimalActivity(text: string): boolean {
  return /tiger|lion|leopard|wildlife|animal|species|livestock|elephant|wolf|bear|dog|cat|bird|herd|fauna|big cat|pet|cattle|deer|monkey|whale|dolphin/.test(
    text.toLowerCase()
  );
}

function getThemePalette(theme: IsoTopicTheme) {
  switch (theme) {
    case "aviation_space":
      return { bgTop: "#0c1e38", bgMid: "#050b18", spotlight: "rgba(56, 189, 248, 0.25)", accent: "#38bdf8", secondary: "#f97316", tertiary: "#a78bfa" };
    case "maritime_rail":
      return { bgTop: "#0c2233", bgMid: "#050e17", spotlight: "rgba(14, 165, 233, 0.24)", accent: "#0ea5e9", secondary: "#f59e0b", tertiary: "#22c55e" };
    case "urban_architecture":
      return { bgTop: "#1a1f2e", bgMid: "#080b12", spotlight: "rgba(99, 102, 241, 0.24)", accent: "#818cf8", secondary: "#34d399", tertiary: "#f59e0b" };
    case "wildlife_ecology":
      return { bgTop: "#0e241b", bgMid: "#06120d", spotlight: "rgba(34, 197, 94, 0.24)", accent: "#22c55e", secondary: "#f97316", tertiary: "#38bdf8" };
    case "civic_governance":
      return { bgTop: "#131c36", bgMid: "#070c1a", spotlight: "rgba(59, 130, 246, 0.24)", accent: "#38bdf8", secondary: "#f97316", tertiary: "#22c55e" };
    case "cold_chain":
      return { bgTop: "#0f222d", bgMid: "#07131a", spotlight: "rgba(56, 189, 248, 0.22)", accent: "#38bdf8", secondary: "#f43f5e", tertiary: "#34d399" };
    case "finance":
      return { bgTop: "#1c1917", bgMid: "#090a0f", spotlight: "rgba(245, 158, 11, 0.22)", accent: "#f59e0b", secondary: "#10b981", tertiary: "#38bdf8" };
    case "bio_science":
      return { bgTop: "#0d2626", bgMid: "#051214", spotlight: "rgba(20, 184, 166, 0.24)", accent: "#2dd4bf", secondary: "#fb7185", tertiary: "#a78bfa" };
    case "energy":
      return { bgTop: "#1f1a10", bgMid: "#080b12", spotlight: "rgba(250, 204, 21, 0.22)", accent: "#facc15", secondary: "#38bdf8", tertiary: "#22c55e" };
    case "retail":
      return { bgTop: "#221614", bgMid: "#0b090c", spotlight: "rgba(251, 146, 60, 0.22)", accent: "#fb923c", secondary: "#f43f5e", tertiary: "#34d399" };
    default:
      return { bgTop: "#111b33", bgMid: "#060b16", spotlight: "rgba(99, 102, 241, 0.22)", accent: "#60a5fa", secondary: "#f97316", tertiary: "#34d399" };
  }
}

/**
 * Animated 2.5D Isometric Person (legs, walking stride, torso, swinging arms, head).
 */
function drawIsoPerson(
  ctx: SKRSContext2D,
  ix: number,
  iy: number,
  iz: number,
  isoOx: number,
  isoOy: number,
  opts: {
    shirtTop: string;
    shirtLeft: string;
    shirtRight: string;
    skin?: string;
    hair?: string;
    walkPhase?: number;
    walking?: boolean;
    raiseArm?: boolean;
    scale?: number;
  }
): void {
  const s = opts.scale ?? 1;
  const phase = opts.walkPhase ?? 0;
  const stride = opts.walking ? Math.sin(phase) * 7 * s : 0;
  const bob = opts.walking ? Math.abs(Math.sin(phase)) * 3 * s : 0;
  const skin = opts.skin ?? "#f1c27d";
  const hair = opts.hair ?? "#1e293b";

  const shadowPt = isoProject(ix, iy, iz, isoOx, isoOy);
  ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
  ctx.beginPath();
  ctx.ellipse(shadowPt.x, shadowPt.y + 2, 13 * s, 7 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  drawIsoBox(ctx, ix - 7 * s + stride * 0.5, iy - 5 * s, iz, 6 * s, 6 * s, 18 * s, isoOx, isoOy, "#334155", "#1e293b", "#0f172a");
  drawIsoBox(ctx, ix + 1 * s - stride * 0.5, iy + 1 * s, iz, 6 * s, 6 * s, 18 * s, isoOx, isoOy, "#475569", "#334155", "#1e293b");

  const torsoZ = iz + 18 * s + bob;
  drawIsoBox(ctx, ix - 8 * s, iy - 7 * s, torsoZ, 16 * s, 14 * s, 22 * s, isoOx, isoOy, opts.shirtTop, opts.shirtLeft, opts.shirtRight);

  const armLift = opts.raiseArm ? 12 * s : -stride * 0.4;
  drawIsoBox(ctx, ix - 11 * s, iy - 4 * s, torsoZ + 6 * s, 4 * s, 5 * s, 14 * s, isoOx, isoOy, opts.shirtLeft, opts.shirtRight, "#0f172a");
  drawIsoBox(ctx, ix + 8 * s, iy - 2 * s, torsoZ + 6 * s + armLift * 0.4, 4 * s, 5 * s, 14 * s, isoOx, isoOy, opts.shirtTop, opts.shirtLeft, opts.shirtRight);

  const headZ = torsoZ + 23 * s;
  drawIsoBox(ctx, ix - 6 * s, iy - 6 * s, headZ, 12 * s, 12 * s, 12 * s, isoOx, isoOy, skin, "#d99b66", "#b87b48");
  drawIsoBox(ctx, ix - 6.5 * s, iy - 6.5 * s, headZ + 9 * s, 13 * s, 13 * s, 4 * s, isoOx, isoOy, hair, hair, "#090d16");
}

/**
 * Animated 2.5D Isometric Animal (tigers, deer/wildlife, livestock, pets).
 */
function drawIsoAnimal(
  ctx: SKRSContext2D,
  ix: number,
  iy: number,
  iz: number,
  isoOx: number,
  isoOy: number,
  opts: {
    bodyTop: string;
    bodyLeft: string;
    bodyRight: string;
    stripes?: boolean;
    gpsCollar?: boolean;
    walkPhase?: number;
    walking?: boolean;
    scale?: number;
  }
): void {
  const s = opts.scale ?? 1;
  const phase = opts.walkPhase ?? 0;
  const stride = opts.walking ? Math.sin(phase) * 6 * s : 0;
  const bob = opts.walking ? Math.abs(Math.sin(phase)) * 2.5 * s : 0;
  const tailSwing = Math.sin(phase * 1.4) * 9 * s;

  const shadowPt = isoProject(ix, iy, iz, isoOx, isoOy);
  ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
  ctx.beginPath();
  ctx.ellipse(shadowPt.x, shadowPt.y + 3, 24 * s, 11 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  drawIsoBox(ctx, ix + 10 * s + stride * 0.5, iy - 7 * s, iz, 5 * s, 5 * s, 13 * s, isoOx, isoOy, opts.bodyLeft, opts.bodyRight, "#0f172a");
  drawIsoBox(ctx, ix + 10 * s - stride * 0.5, iy + 3 * s, iz, 5 * s, 5 * s, 13 * s, isoOx, isoOy, opts.bodyTop, opts.bodyLeft, opts.bodyRight);
  drawIsoBox(ctx, ix - 13 * s - stride * 0.5, iy - 7 * s, iz, 5 * s, 5 * s, 13 * s, isoOx, isoOy, opts.bodyLeft, opts.bodyRight, "#0f172a");
  drawIsoBox(ctx, ix - 13 * s + stride * 0.5, iy + 3 * s, iz, 5 * s, 5 * s, 13 * s, isoOx, isoOy, opts.bodyTop, opts.bodyLeft, opts.bodyRight);

  const bodyZ = iz + 12 * s + bob;
  drawIsoBox(ctx, ix - 16 * s, iy - 8 * s, bodyZ, 32 * s, 16 * s, 15 * s, isoOx, isoOy, opts.bodyTop, opts.bodyLeft, opts.bodyRight);

  if (opts.stripes) {
    drawIsoBox(ctx, ix - 8 * s, iy - 8.5 * s, bodyZ + 4 * s, 4 * s, 17 * s, 11.5 * s, isoOx, isoOy, "#0f172a", "#020617", "#020617");
    drawIsoBox(ctx, ix + 2 * s, iy - 8.5 * s, bodyZ + 4 * s, 4 * s, 17 * s, 11.5 * s, isoOx, isoOy, "#0f172a", "#020617", "#020617");
  }
  if (opts.gpsCollar) {
    drawIsoBox(ctx, ix + 13 * s, iy - 8.5 * s, bodyZ + 3 * s, 4.5 * s, 17 * s, 12.5 * s, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
  }

  drawIsoBox(ctx, ix - 26 * s, iy - 2 * s + tailSwing * 0.35, bodyZ + 9 * s, 11 * s, 4 * s, 4 * s, isoOx, isoOy, opts.bodyTop, opts.bodyLeft, "#0f172a");

  const headZ = bodyZ + 7 * s;
  drawIsoBox(ctx, ix + 14 * s, iy - 7 * s, headZ, 13 * s, 14 * s, 13 * s, isoOx, isoOy, opts.bodyTop, opts.bodyLeft, opts.bodyRight);
  drawIsoBox(ctx, ix + 25 * s, iy - 4.5 * s, headZ, 5 * s, 9 * s, 7 * s, isoOx, isoOy, "#fef3c7", "#fde68a", "#fcd34d");
  drawIsoBox(ctx, ix + 16 * s, iy - 6.5 * s, headZ + 12 * s, 3.5 * s, 3.5 * s, 4 * s, isoOx, isoOy, opts.bodyLeft, "#0f172a", "#020617");
  drawIsoBox(ctx, ix + 16 * s, iy + 3 * s, headZ + 12 * s, 3.5 * s, 3.5 * s, 4 * s, isoOx, isoOy, opts.bodyLeft, "#0f172a", "#020617");
}

/**
 * Universal 2.5D Isometric Vehicle Renderer:
 * Supports Aircraft / Jetliner, High-Speed Train, Cargo Ship, Space Rocket, Car/EV, and Freight Truck.
 */
function drawIsoVehicle(
  ctx: SKRSContext2D,
  kind: IsoVehicleKind,
  isoOx: number,
  isoOy: number,
  sceneProgress: number,
  buildIn: number,
  accent: string,
  secondary: string
): void {
  if (kind === "aircraft") {
    // Cloud Deck + Runway Grid
    drawIsoBox(ctx, -230, -140, -14, 460, 280, 14, isoOx, isoOy, "#0f172a", "#090d16", "#020617");
    const flyX = -95 + sceneProgress * 185;
    const flyZ = 68 + Math.sin(sceneProgress * Math.PI) * 32;
    // Contrail ribbons behind engines
    for (let c = 1; c <= 4; c++) {
      const trailPt = isoProject(flyX - 85 - c * 28, 0, flyZ + 12, isoOx, isoOy);
      ctx.fillStyle = `rgba(224, 242, 254, ${0.55 - c * 0.11})`;
      ctx.beginPath();
      ctx.arc(trailPt.x, trailPt.y, 12 - c * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fuselage + Cockpit + Swept Wings + Tail Fin
    drawIsoBox(ctx, flyX - 80, -18, flyZ, 165, 36, 30 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, flyX + 62, -14, flyZ + 6, 26, 28, 18 * buildIn, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
    drawIsoBox(ctx, flyX - 24, -110, flyZ + 8, 52, 220, 8 * buildIn, isoOx, isoOy, accent, "#0284c7", "#0369a1");
    drawIsoBox(ctx, flyX - 78, -6, flyZ + 30 * buildIn, 28, 12, 34 * buildIn, isoOx, isoOy, secondary, "#ea580c", "#c2410c");
  } else if (kind === "train") {
    // Ballast Track Bed + Steel Rails + Multi-Car High-Speed Bullet Train
    drawIsoBox(ctx, -235, -115, -14, 470, 230, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -225, -24, 0, 450, 6, 4, isoOx, isoOy, "#94a3b8", "#64748b", "#475569");
    drawIsoBox(ctx, -225, 18, 0, 450, 6, 4, isoOx, isoOy, "#94a3b8", "#64748b", "#475569");
    const trainX = -135 + sceneProgress * 155;
    // Rear Passenger Coach
    drawIsoBox(ctx, trainX - 115, -26, 5, 120, 52, 46 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, trainX - 115, -27, 26 * buildIn, 120, 54, 10, isoOx, isoOy, accent, "#0284c7", "#0369a1");
    // Aerodynamic Locomotive Nose Car
    drawIsoBox(ctx, trainX + 14, -26, 5, 125, 52, 46 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, trainX + 14, -27, 26 * buildIn, 125, 54, 10, isoOx, isoOy, secondary, "#ea580c", "#c2410c");
    drawIsoBox(ctx, trainX + 115, -20, 14, 24, 40, 26 * buildIn, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
  } else if (kind === "ship") {
    // Ocean Water Basin + Animated Wake Ripples + Container Cargo Vessel
    drawIsoBox(ctx, -230, -145, -14, 460, 290, 14, isoOx, isoOy, "#0369a1", "#075985", "#0c4a6e");
    const shipX = -80 + sceneProgress * 135;
    // Hull + Deck + Bridge Tower + Stacked ISO Containers
    drawIsoBox(ctx, shipX - 125, -48, 0, 250, 96, 36 * buildIn, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, shipX - 115, -42, 36 * buildIn, 230, 84, 8, isoOx, isoOy, "#475569", "#334155", "#1e293b");
    drawIsoBox(ctx, shipX - 105, -28, 44 * buildIn, 38, 56, 58 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, shipX - 45, -34, 44 * buildIn, 64, 68, 34 * buildIn, isoOx, isoOy, secondary, "#e11d48", "#be123c");
    drawIsoBox(ctx, shipX + 26, -34, 44 * buildIn, 64, 68, 42 * buildIn, isoOx, isoOy, accent, "#0284c7", "#0369a1");
  } else if (kind === "rocket") {
    // Launch Pad + Gantry Tower + Vertical Liftoff Rocket + Exhaust Plume
    drawIsoBox(ctx, -195, -195, -14, 390, 390, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    // Launch Umbilical Gantry
    drawIsoBox(ctx, -88, -32, 0, 26, 26, 175 * buildIn, isoOx, isoOy, "#64748b", "#475569", "#334155");
    const liftZ = 14 + Math.pow(sceneProgress, 1.5) * 145;
    // Exhaust Flame Plume
    const flamePt = isoProject(0, 0, Math.max(4, liftZ - 12), isoOx, isoOy);
    ctx.fillStyle = "rgba(249, 115, 22, 0.78)";
    ctx.beginPath();
    ctx.arc(flamePt.x, flamePt.y + 10, 24 + Math.sin(sceneProgress * 30) * 5, 0, Math.PI * 2);
    ctx.fill();
    // Main Booster + Fairing Cone
    drawIsoBox(ctx, -22, -22, liftZ, 44, 44, 128 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, -23, -23, liftZ + 55 * buildIn, 46, 46, 18, isoOx, isoOy, secondary, "#ea580c", "#c2410c");
    drawIsoBox(ctx, -15, -15, liftZ + 128 * buildIn, 30, 30, 34 * buildIn, isoOx, isoOy, accent, "#0284c7", "#0369a1");
  } else if (kind === "car") {
    // Urban EV / Passenger Car Gliding on Smart Roadway
    drawIsoBox(ctx, -225, -120, -14, 450, 240, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    for (let d = 0; d < 5; d++) {
      const dashX = 180 - ((sceneProgress * 420 + d * 95) % 420);
      drawIsoBox(ctx, dashX, 0, 1, 38, 10, 2, isoOx, isoOy, "#64748b", "#475569", "#334155");
    }
    const carX = -75 + sceneProgress * 150;
    drawIsoBox(ctx, carX - 58, -32, 12, 116, 64, 28 * buildIn, isoOx, isoOy, accent, "#0284c7", "#0369a1");
    drawIsoBox(ctx, carX - 32, -26, 40 * buildIn, 66, 52, 24 * buildIn, isoOx, isoOy, "#e0f2fe", "#7dd3fc", "#38bdf8");
    [-36, 32].forEach((wx) => {
      drawIsoBox(ctx, carX + wx, -36, 0, 20, 72, 16, isoOx, isoOy, "#0f172a", "#020617", "#1e293b");
    });
  } else {
    // Freight / Delivery Truck
    drawIsoBox(ctx, -230, -120, -14, 460, 240, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    const truckOffset = -45 + sceneProgress * 95;
    drawIsoBox(ctx, truckOffset - 115, -46, 18, 155, 92, 92 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, truckOffset - 115, -48, 52 * buildIn, 155, 96, 16, isoOx, isoOy, accent, "#0284c7", "#0369a1");
    drawIsoBox(ctx, truckOffset + 46, -42, 18, 58, 84, 72 * buildIn, isoOx, isoOy, secondary, "#be123c", "#881337");
    [-85, -35, 68].forEach((wx) => {
      drawIsoBox(ctx, truckOffset + wx, -50, 0, 24, 100, 22, isoOx, isoOy, "#0f172a", "#020617", "#1e293b");
    });
  }
}

/**
 * Universal 2.5D Isometric Building Renderer:
 * Supports Skyscraper/HQ, Factory/Power Plant, Hospital/Lab, Bank/Treasury, School/Civic Dome, and Residential Homes.
 */
function drawIsoBuilding(
  ctx: SKRSContext2D,
  kind: IsoBuildingKind,
  isoOx: number,
  isoOy: number,
  sceneProgress: number,
  buildIn: number,
  accent: string,
  secondary: string,
  tertiary: string
): void {
  drawIsoBox(ctx, -210, -175, -14, 420, 350, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");

  if (kind === "skyscraper") {
    // Glass Curtain-Wall Tower + Illuminated Floors + Communication Spire
    drawIsoBox(ctx, -78, -78, 0, 156, 156, 210 * buildIn, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
    for (let fl = 1; fl <= 4; fl++) {
      const fz = fl * 42 * buildIn;
      drawIsoBox(ctx, -80, -80, fz, 160, 160, 7, isoOx, isoOy, "#e0f2fe", "#bae6fd", "#7dd3fc");
    }
    drawIsoBox(ctx, -10, -10, 210 * buildIn, 20, 20, 56 * buildIn, isoOx, isoOy, secondary, "#ea580c", "#c2410c");
  } else if (kind === "factory") {
    // Industrial Plant Hall + Twin Cooling/Exhaust Stacks + Animated Steam Plumes
    drawIsoBox(ctx, -145, -85, 0, 235, 165, 92 * buildIn, isoOx, isoOy, "#64748b", "#475569", "#334155");
    drawIsoBox(ctx, -135, -75, 92 * buildIn, 215, 145, 16 * buildIn, isoOx, isoOy, accent, "#0284c7", "#0369a1");
    [95, 138].forEach((sx, idx) => {
      drawIsoBox(ctx, sx, -55, 0, 28, 28, 155 * buildIn, isoOx, isoOy, "#94a3b8", "#64748b", "#475569");
      const puffProg = (sceneProgress * 2.0 + idx * 0.4) % 1;
      const puffPt = isoProject(sx + 14 + puffProg * 35, -41, 160 * buildIn + puffProg * 55, isoOx, isoOy);
      ctx.fillStyle = `rgba(226, 232, 240, ${(1 - puffProg) * 0.65})`;
      ctx.beginPath();
      ctx.arc(puffPt.x, puffPt.y, 12 + puffProg * 14, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (kind === "hospital") {
    // Clinical Medical Campus + Rooftop Medical Cross Emblem
    drawIsoBox(ctx, -135, -90, 0, 270, 175, 118 * buildIn, isoOx, isoOy, "#f8fafc", "#e2e8f0", "#cbd5e1");
    drawIsoBox(ctx, -135, -92, 62 * buildIn, 270, 179, 12, isoOx, isoOy, "#0ea5e9", "#0284c7", "#0369a1");
    // Red Medical Cross on Roof
    drawIsoBox(ctx, -32, -10, 118 * buildIn, 64, 20, 10 * buildIn, isoOx, isoOy, "#ef4444", "#dc2626", "#b91c1c");
    drawIsoBox(ctx, -10, -32, 118 * buildIn, 20, 64, 10 * buildIn, isoOx, isoOy, "#ef4444", "#dc2626", "#b91c1c");
  } else if (kind === "bank") {
    // Pillared Financial Reserve / Central Bank + Gold Core
    drawIsoBox(ctx, -135, -95, 0, 270, 190, 20 * buildIn, isoOx, isoOy, "#94a3b8", "#64748b", "#475569");
    drawIsoBox(ctx, -115, -75, 20 * buildIn, 230, 150, 96 * buildIn, isoOx, isoOy, "#e2e8f0", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, -125, -85, 116 * buildIn, 250, 170, 24 * buildIn, isoOx, isoOy, "#f59e0b", "#d97706", "#b45309");
  } else if (kind === "school") {
    // Academic / Civic Campus Building + Clock/Flag Spire
    drawIsoBox(ctx, -145, -85, 0, 290, 165, 96 * buildIn, isoOx, isoOy, "#fb923c", "#ea580c", "#c2410c");
    drawIsoBox(ctx, -38, -38, 96 * buildIn, 76, 76, 46 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, -6, -6, 142 * buildIn, 12, 12, 42 * buildIn, isoOx, isoOy, accent, "#0284c7", "#0369a1");
  } else {
    // Residential / Housing Neighborhood Cluster (2 Modern Houses)
    drawIsoBox(ctx, -140, -65, 0, 115, 115, 76 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, -146, -71, 76 * buildIn, 127, 127, 22 * buildIn, isoOx, isoOy, secondary, "#e11d48", "#be123c");
    drawIsoBox(ctx, 25, -55, 0, 115, 115, 92 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, 19, -61, 92 * buildIn, 127, 127, 22 * buildIn, isoOx, isoOy, tertiary, "#059669", "#047857");
  }
}

function rankArchetypesForBeat(beatText: string, theme: IsoTopicTheme): IsoArchetype[] {
  const s = beatText.toLowerCase();
  const ranked: IsoArchetype[] = [];

  if (detectVehicleKind(s)) ranked.push("universal_vehicle");
  if (detectBuildingKind(s)) ranked.push("universal_building");
  if (/tiger|lion|leopard|wildlife|animal|forest|ranger|sanctuary|reserve|habitat|livestock|collar|cage|big cat/.test(s)) ranked.push("wildlife_sanctuary");
  if (/booth|polling|voter|citizen|queue|station|biometric|cast|line/.test(s)) ranked.push("polling_station");
  if (/vvpat|paper|slip|print|ballot|audit|receipt|record|document|verify/.test(s)) ranked.push("document_printer");
  if (/strongroom|vault|seal|cctv|tamper|lock|security|guard|safe|protect/.test(s)) ranked.push("secure_vault");
  if (/counting|hub|district|live|result|telemetry|signal|real-time|network|iot|sensor/.test(s)) ranked.push("telemetry_beacon");
  if (/tally|count|100 million|percent|cost|price|dollar|\$|rupee|\u20b9|profit|margin|constituenc/.test(s)) ranked.push("value_pillars");
  if (/cool|temp|33|75|chill|freeze|thermal|heat|harvest|pre-cool|chamber/.test(s)) ranked.push("cooling_chamber");
  if (/oxygen|carbon|gas|atmosphere|liner|co2|o2|respirat/.test(s)) ranked.push("atmosphere_dome");
  if (/sort|warehouse|shelf|hour|72|automat|conveyor|pack|distribut|retail/.test(s)) ranked.push("conveyor_sorter");
  if (/layer|core|inside|anatomy|structure|system|chip|engine/.test(s)) ranked.push("core_cutaway");
  if (/global|connect|orbit|ecosystem|chain/.test(s)) ranked.push("orbital_network");

  if (theme === "aviation_space" || theme === "maritime_rail") {
    for (const a of ["universal_vehicle", "telemetry_beacon", "orbital_network", "universal_building", "value_pillars"] as IsoArchetype[]) {
      if (!ranked.includes(a)) ranked.push(a);
    }
  } else if (theme === "urban_architecture") {
    for (const a of ["universal_building", "universal_vehicle", "value_pillars", "core_cutaway", "telemetry_beacon"] as IsoArchetype[]) {
      if (!ranked.includes(a)) ranked.push(a);
    }
  } else if (theme === "wildlife_ecology") {
    for (const a of ["wildlife_sanctuary", "telemetry_beacon", "universal_vehicle", "orbital_network", "value_pillars"] as IsoArchetype[]) {
      if (!ranked.includes(a)) ranked.push(a);
    }
  } else if (theme === "civic_governance") {
    for (const a of ["polling_station", "document_printer", "secure_vault", "telemetry_beacon", "value_pillars"] as IsoArchetype[]) {
      if (!ranked.includes(a)) ranked.push(a);
    }
  } else if (theme === "cold_chain") {
    for (const a of ["cooling_chamber", "reefer_transit", "atmosphere_dome", "telemetry_beacon", "conveyor_sorter"] as IsoArchetype[]) {
      if (!ranked.includes(a)) ranked.push(a);
    }
  }
  for (const a of ALL_ISO_ARCHETYPES) {
    if (!ranked.includes(a)) ranked.push(a);
  }
  return ranked;
}

const deterministicVideoPlanCache = new Map<string, IsoArchetype[]>();

function getUniqueArchetypeForScene(
  videoKey: string,
  beat: DynamicStoryboardBeat,
  sceneIdx: number,
  sceneCount: number,
  theme: IsoTopicTheme
): IsoArchetype {
  let plan = deterministicVideoPlanCache.get(videoKey);
  if (!plan) {
    plan = [];
    deterministicVideoPlanCache.set(videoKey, plan);
  }
  if (plan[sceneIdx]) return plan[sceneIdx]!;

  const used = new Set(plan.filter(Boolean));
  const beatStr = `${beat.beatSummary || ""} ${beat.propTitle || ""} ${(beat.propMetrics || []).join(" ")}`;
  const candidates = rankArchetypesForBeat(beatStr, theme);
  const chosen = candidates.find((c) => !used.has(c)) ?? ALL_ISO_ARCHETYPES[sceneIdx % ALL_ISO_ARCHETYPES.length]!;
  plan[sceneIdx] = chosen;
  return chosen;
}

function drawFittingPill(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  text: string,
  accentColor: string,
  maxWidth: number
): void {
  const clean = text.trim().toUpperCase();
  if (!clean) return;
  let fontSize = 20;
  ctx.font = `900 ${fontSize}px 'Segoe UI', Arial, sans-serif`;
  while (ctx.measureText(clean).width > maxWidth - 52 && fontSize > 13) {
    fontSize -= 1;
    ctx.font = `900 ${fontSize}px 'Segoe UI', Arial, sans-serif`;
  }
  const pillW = Math.min(maxWidth, Math.max(220, ctx.measureText(clean).width + 54));
  const pillH = 44;
  drawRoundedRect(ctx, cx - pillW / 2, cy - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fillStyle = "rgba(9, 14, 26, 0.90)";
  ctx.fill();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2.2;
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "center";
  ctx.fillText(clean, cx, cy + Math.round(fontSize * 0.35));
}

function renderIsometricTechScene(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  t: number,
  videoTitle: string,
  beat: DynamicStoryboardBeat,
  sceneIdx: number,
  sceneCount: number,
  sceneProgress: number
): void {
  const cx = w * 0.5;
  const cy = h * 0.44;
  const fullContext = `${videoTitle} ${beat.beatSummary || ""} ${beat.propTitle || ""}`;
  const theme = detectTopicTheme(fullContext);
  const showPeople = hasHumanActivity(fullContext) || theme === "civic_governance" || theme === "retail" || theme === "wildlife_ecology";
  const showAnimals = hasAnimalActivity(fullContext) || theme === "wildlife_ecology";
  const palette = getThemePalette(theme);
  const archetype = getUniqueArchetypeForScene(`${videoTitle}::${sceneCount}`, beat, sceneIdx, sceneCount, theme);

  const buildIn = easeOutCubic(Math.min(1, sceneProgress / 0.22));
  const activeFlow = Math.max(0, Math.min(1, (sceneProgress - 0.1) / 0.9));
  const smoothCameraScale = 1.08 + sceneProgress * 0.11;
  const smoothPanX = (sceneIdx % 2 === 0 ? -1 : 1) * (sceneProgress - 0.5) * 24;

  // 1. Studio Backdrop + Grid
  const bg = ctx.createRadialGradient(cx, cy - 40, 40, cx, cy, h * 0.8);
  bg.addColorStop(0, palette.bgTop);
  bg.addColorStop(0.55, palette.bgMid);
  bg.addColorStop(1, "#020408");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(148, 163, 184, 0.055)";
  ctx.lineWidth = 1.25;
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

  const stageGlow = ctx.createRadialGradient(cx, cy + 10, 20, cx, cy + 10, 430);
  stageGlow.addColorStop(0, palette.spotlight);
  stageGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = stageGlow;
  ctx.fillRect(0, 0, w, h);

  // 2. Top Chapter Stepper
  const totalSteps = Math.min(6, Math.max(3, sceneCount));
  const topY = 82;
  const barStartX = 84;
  const barEndX = w - 166;
  const stepSpan = (barEndX - barStartX) / Math.max(1, totalSteps - 1);

  ctx.strokeStyle = "rgba(148, 163, 184, 0.24)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(barStartX, topY);
  ctx.lineTo(barEndX, topY);
  ctx.stroke();

  const activeStep = Math.min(totalSteps - 1, sceneIdx);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(barStartX, topY);
  ctx.lineTo(barStartX + stepSpan * Math.min(totalSteps - 1, activeStep + sceneProgress), topY);
  ctx.stroke();

  for (let i = 0; i < totalSteps; i++) {
    const sx = barStartX + i * stepSpan;
    const isCur = i === activeStep;
    const isPast = i < activeStep;
    ctx.fillStyle = isCur ? palette.accent : isPast ? "#1e293b" : "#0f172a";
    ctx.beginPath();
    ctx.arc(sx, topY, isCur ? 18 : 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isCur ? "#ffffff" : isPast ? palette.accent : "#475569";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = isCur ? "#050911" : "#cbd5e1";
    ctx.font = "bold 13px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1).padStart(2, "0"), sx, topY + 5);
  }

  drawRoundedRect(ctx, w - 138, topY - 16, 90, 32, 16);
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
  ctx.fill();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = palette.accent;
  ctx.font = "bold 14px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`0${activeStep + 1}/0${totalSteps}`, w - 93, topY + 5);

  // 3. Extract Real Metrics Only
  const cleanedMetrics = (beat.propMetrics ?? [])
    .map((m) => String(m ?? "").trim())
    .filter((m) => m.length >= 2 && !/^PHASE\s*\d/i.test(m));

  const fallbackPhrases = (beat.beatSummary || "")
    .split(/[,.;:|\-]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4 && x.length <= 42);

  const metrics: string[] = [];
  for (const cand of [...cleanedMetrics, ...fallbackPhrases]) {
    if (!metrics.some((existing) => existing.toLowerCase() === cand.toLowerCase())) {
      metrics.push(cand);
    }
    if (metrics.length === 3) break;
  }
  if (metrics.length === 0) metrics.push(videoTitle.slice(0, 36));

  const rawTitle = (beat.propTitle || beat.beatSummary || videoTitle).trim();
  const headerTitle = !rawTitle || /^PHASE\s*\d/i.test(rawTitle) ? metrics[0]! : rawTitle;
  drawFittingPill(ctx, cx, 170, headerTitle, palette.accent, w - 110);

  // 4. Continuous-Motion 2.5D Illustrated Stage
  const isoOx = cx + smoothPanX;
  const isoOy = cy + 52;

  ctx.save();
  ctx.translate(isoOx, isoOy);
  ctx.scale(smoothCameraScale * (0.92 + 0.08 * buildIn), smoothCameraScale * (0.92 + 0.08 * buildIn));
  ctx.translate(-isoOx, -isoOy);

  if (archetype === "universal_vehicle") {
    const vKind = detectVehicleKind(fullContext) ?? "aircraft";
    drawIsoVehicle(ctx, vKind, isoOx, isoOy, sceneProgress, buildIn, palette.accent, palette.secondary);
    if (showPeople && (vKind === "train" || vKind === "car")) {
      drawIsoPerson(ctx, -110, 82, 0, isoOx, isoOy, {
        shirtTop: palette.tertiary,
        shirtLeft: "#16a34a",
        shirtRight: "#15803d",
        walking: true,
        walkPhase: sceneProgress * 14,
        scale: 0.9,
      });
    }
    const vLbl = isoProject(0, 0, 142 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, vLbl.x, vLbl.y, metrics[0]!, palette.accent);
  } else if (archetype === "universal_building") {
    const bKind = detectBuildingKind(fullContext) ?? "skyscraper";
    drawIsoBuilding(ctx, bKind, isoOx, isoOy, sceneProgress, buildIn, palette.accent, palette.secondary, palette.tertiary);
    if (showPeople) {
      drawIsoPerson(ctx, -95 + sceneProgress * 110, 128, 0, isoOx, isoOy, {
        shirtTop: palette.secondary,
        shirtLeft: "#ea580c",
        shirtRight: "#c2410c",
        walking: true,
        walkPhase: sceneProgress * 16,
        scale: 0.92,
      });
      drawIsoPerson(ctx, 85, 132, 0, isoOx, isoOy, {
        shirtTop: palette.accent,
        shirtLeft: "#0284c7",
        shirtRight: "#0369a1",
        raiseArm: true,
        scale: 0.92,
      });
    }
    const bLbl = isoProject(0, 0, 168 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, bLbl.x, bLbl.y, metrics[0]!, palette.accent);
  } else if (archetype === "wildlife_sanctuary") {
    drawIsoBox(ctx, -215, -155, -14, 430, 310, 14, isoOx, isoOy, "#14532d", "#052e16", "#022c22");
    const trees = [
      { tx: -165, ty: -115, h: 68 },
      { tx: -95, ty: -125, h: 82 },
      { tx: 145, ty: -110, h: 74 },
      { tx: 165, ty: 85, h: 64 },
    ];
    trees.forEach((tr) => {
      drawIsoBox(ctx, tr.tx - 6, tr.ty - 6, 0, 12, 12, tr.h * 0.45 * buildIn, isoOx, isoOy, "#78350f", "#451a03", "#271003");
      drawIsoBox(ctx, tr.tx - 24, tr.ty - 24, tr.h * 0.4 * buildIn, 48, 48, tr.h * 0.55 * buildIn, isoOx, isoOy, "#22c55e", "#16a34a", "#15803d");
    });

    drawIsoBox(ctx, 45, -95, 0, 26, 26, 95 * buildIn, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
    const camTop = isoProject(58, -82, 102 * buildIn, isoOx, isoOy);
    const pulseProg = (sceneProgress * 2.2) % 1;
    ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - pulseProg) * 0.85})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(camTop.x, camTop.y, 18 + pulseProg * 110, 10 + pulseProg * 60, 0, 0, Math.PI * 2);
    ctx.stroke();

    const tigerX = -110 + sceneProgress * 155;
    const tigerY = -10 + Math.sin(sceneProgress * Math.PI * 2) * 26;
    drawIsoAnimal(ctx, tigerX, tigerY, 0, isoOx, isoOy, {
      bodyTop: "#f97316",
      bodyLeft: "#ea580c",
      bodyRight: "#c2410c",
      stripes: true,
      gpsCollar: true,
      walking: true,
      walkPhase: sceneProgress * 18,
      scale: 1.15,
    });

    drawIsoAnimal(ctx, tigerX - 68, tigerY + 48, 0, isoOx, isoOy, {
      bodyTop: "#d97706",
      bodyLeft: "#b45309",
      bodyRight: "#92400e",
      stripes: false,
      gpsCollar: false,
      walking: true,
      walkPhase: sceneProgress * 18 + 1.5,
      scale: 0.88,
    });

    drawIsoPerson(ctx, -135, 95, 0, isoOx, isoOy, {
      shirtTop: "#22c55e",
      shirtLeft: "#16a34a",
      shirtRight: "#15803d",
      raiseArm: true,
      scale: 0.95,
    });
    drawIsoPerson(ctx, -85, 112, 0, isoOx, isoOy, {
      shirtTop: "#38bdf8",
      shirtLeft: "#0284c7",
      shirtRight: "#0369a1",
      walking: true,
      walkPhase: sceneProgress * 12,
      scale: 0.95,
    });

    const wLbl = isoProject(tigerX + 10, tigerY, 64 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, wLbl.x, wLbl.y, metrics[0]!, "#22c55e");
  } else if (archetype === "polling_station") {
    drawIsoBox(ctx, -215, -155, -14, 430, 310, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, 55, -125, 0, 115, 16, 130 * buildIn, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
    drawIsoBox(ctx, 154, -125, 0, 16, 115, 130 * buildIn, isoOx, isoOy, "#7dd3fc", "#0284c7", "#0369a1");
    drawIsoBox(ctx, 88, -82, 0, 46, 46, 62 * buildIn, isoOx, isoOy, "#f8fafc", "#cbd5e1", "#94a3b8");
    drawIsoBox(ctx, 94, -76, 62 * buildIn, 34, 34, 14, isoOx, isoOy, "#22c55e", "#16a34a", "#15803d");

    drawIsoBox(ctx, -85, -110, 0, 88, 52, 46 * buildIn, isoOx, isoOy, "#f97316", "#ea580c", "#c2410c");
    drawIsoPerson(ctx, -45, -135, 0, isoOx, isoOy, {
      shirtTop: "#38bdf8",
      shirtLeft: "#0284c7",
      shirtRight: "#0369a1",
      raiseArm: true,
      scale: 0.95,
    });
    drawIsoPerson(ctx, 112, -25, 0, isoOx, isoOy, {
      shirtTop: "#22c55e",
      shirtLeft: "#16a34a",
      shirtRight: "#15803d",
      raiseArm: true,
      scale: 0.95,
    });

    const voterColors = [
      { top: "#f43f5e", left: "#e11d48", right: "#be123c" },
      { top: "#a78bfa", left: "#7c3aed", right: "#6d28d9" },
      { top: "#facc15", left: "#eab308", right: "#ca8a04" },
    ];
    voterColors.forEach((vc, idx) => {
      const qStep = sceneProgress * 0.65 * 45;
      const vx = -165 + idx * 54 + qStep;
      const vy = 45 - idx * 24;
      drawIsoPerson(ctx, vx, vy, 0, isoOx, isoOy, {
        shirtTop: vc.top,
        shirtLeft: vc.left,
        shirtRight: vc.right,
        walking: true,
        walkPhase: sceneProgress * 18 + idx * 2.1,
        scale: 0.95,
      });
    });

    const boothLbl = isoProject(110, -70, 152 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, boothLbl.x, boothLbl.y, metrics[0]!, "#38bdf8");
  } else if (archetype === "document_printer") {
    drawIsoBox(ctx, -200, -145, -14, 400, 290, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -78, -68, 0, 156, 128, 78 * buildIn, isoOx, isoOy, "#e2e8f0", "#94a3b8", "#64748b");
    drawIsoBox(ctx, -45, -35, 78 * buildIn, 90, 68, 46 * buildIn, isoOx, isoOy, "rgba(56, 189, 248, 0.45)", "rgba(2, 132, 199, 0.35)", "rgba(3, 105, 161, 0.35)");

    for (let s = 0; s < 3; s++) {
      const slipProg = (sceneProgress * 1.8 + s * 0.33) % 1;
      const slipZ = 82 * buildIn + Math.sin(slipProg * Math.PI) * 42;
      drawIsoBox(ctx, -24 + s * 16, -16, slipZ, 22, 28, 3, isoOx, isoOy, "#ffffff", "#e2e8f0", "#cbd5e1");
    }

    drawIsoPerson(ctx, -125, 25, 0, isoOx, isoOy, {
      shirtTop: "#f97316",
      shirtLeft: "#ea580c",
      shirtRight: "#c2410c",
      raiseArm: true,
      scale: 0.96,
    });
    drawIsoPerson(ctx, 115, -20, 0, isoOx, isoOy, {
      shirtTop: "#22c55e",
      shirtLeft: "#16a34a",
      shirtRight: "#15803d",
      raiseArm: true,
      scale: 0.96,
    });

    const pLbl = isoProject(0, 0, 148 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, pLbl.x, pLbl.y, metrics[0]!, "#38bdf8");
  } else if (archetype === "secure_vault") {
    drawIsoBox(ctx, -200, -150, -14, 400, 300, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -110, -110, 0, 220, 220, 138 * buildIn, isoOx, isoOy, "#475569", "#334155", "#1e293b");
    drawIsoBox(ctx, -56, 110, 14, 112, 18, 108 * buildIn, isoOx, isoOy, "#94a3b8", "#64748b", "#475569");
    drawIsoBox(ctx, -22, 128, 52 * buildIn, 44, 10, 44 * buildIn, isoOx, isoOy, "#22c55e", "#16a34a", "#15803d");

    const scanAngle = -0.6 + Math.sin(sceneProgress * Math.PI * 3) * 0.7;
    const camPt = isoProject(-110, 110, 142 * buildIn, isoOx, isoOy);
    ctx.strokeStyle = "rgba(249, 115, 22, 0.55)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(camPt.x, camPt.y);
    ctx.lineTo(camPt.x + Math.cos(scanAngle) * 140, camPt.y + 85);
    ctx.stroke();

    const patrolX = -90 + sceneProgress * 180;
    drawIsoPerson(ctx, patrolX, 148, 0, isoOx, isoOy, {
      shirtTop: "#38bdf8",
      shirtLeft: "#0284c7",
      shirtRight: "#0369a1",
      walking: true,
      walkPhase: sceneProgress * 16,
      scale: 0.94,
    });

    const vLbl = isoProject(0, 0, 162 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, vLbl.x, vLbl.y, metrics[0]!, "#22c55e");
  } else if (archetype === "cooling_chamber") {
    drawIsoBox(ctx, -205, -145, -14, 410, 290, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -170, -115, 0, 250, 24, 150 * buildIn, isoOx, isoOy, "#38bdf8", "#0284c7", "#0369a1");
    drawIsoBox(ctx, -170, -115, 134 * buildIn, 250, 195, 16, isoOx, isoOy, "#7dd3fc", "#0284c7", "#0369a1");
    drawIsoBox(ctx, -125, -55, 0, 82, 82, 54 * buildIn, isoOx, isoOy, "#f43f5e", "#e11d48", "#be123c");
    drawIsoBox(ctx, -25, -55, 0, 82, 82, 54 * buildIn, isoOx, isoOy, "#fb7185", "#e11d48", "#9f1239");

    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const waveProg = (sceneProgress * 2.2 + wIdx * 0.25) % 1;
      const mistPt = isoProject(-150 + waveProg * 220, -10 + (wIdx - 1.5) * 28, 72, isoOx, isoOy);
      ctx.fillStyle = `rgba(186, 230, 253, ${Math.sin(waveProg * Math.PI) * 0.65})`;
      ctx.beginPath();
      ctx.arc(mistPt.x, mistPt.y, 8 + waveProg * 10, 0, Math.PI * 2);
      ctx.fill();
    }

    const gaugeFill = Math.max(0.18, 1 - activeFlow * 0.68);
    drawIsoBox(ctx, 115, -45, 0, 56, 56, 175 * buildIn, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    const colTop = activeFlow > 0.45 ? "#38bdf8" : "#f43f5e";
    drawIsoBox(ctx, 121, -39, 4, 44, 44, 165 * buildIn * gaugeFill, isoOx, isoOy, colTop, "#0284c7", "#0369a1");

    const gLabel = isoProject(143, -17, 192 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, gLabel.x, gLabel.y, metrics[0]!, colTop);
  } else if (archetype === "reefer_transit") {
    drawIsoVehicle(ctx, "truck", isoOx, isoOy, sceneProgress, buildIn, palette.accent, palette.secondary);
    const tLbl = isoProject(0, 0, 132 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, tLbl.x, tLbl.y, metrics[0]!, palette.accent);
  } else if (archetype === "atmosphere_dome") {
    drawIsoBox(ctx, -185, -185, -14, 370, 370, 14, isoOx, isoOy, "#0f172a", "#090d16", "#020617");
    drawIsoBox(ctx, -68, -68, 0, 136, 136, 98 * buildIn, isoOx, isoOy, palette.secondary, "#be123c", "#881337");
    drawIsoBox(ctx, -84, -84, 0, 168, 168, 114 * buildIn, isoOx, isoOy, "rgba(56, 189, 248, 0.32)", "rgba(2, 132, 199, 0.25)", "rgba(3, 105, 161, 0.25)");

    for (let m = 0; m < 6; m++) {
      const angle = sceneProgress * Math.PI * 2.5 + (m * Math.PI) / 3;
      const rx = Math.cos(angle) * 145;
      const ry = Math.sin(angle) * 145;
      const rz = 65 + Math.sin(angle * 2) * 24;
      const pt = isoProject(rx, ry, rz, isoOx, isoOy);
      ctx.fillStyle = m % 2 === 0 ? palette.accent : palette.tertiary;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const domeLbl = isoProject(0, 0, 148 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, domeLbl.x, domeLbl.y, metrics[0]!, palette.accent);
  } else if (archetype === "telemetry_beacon") {
    drawIsoBox(ctx, -195, -195, -14, 390, 390, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -48, -48, 0, 96, 96, 86 * buildIn, isoOx, isoOy, "#334155", "#1e293b", "#0f172a");
    drawIsoBox(ctx, -14, -14, 86 * buildIn, 28, 28, 72 * buildIn, isoOx, isoOy, palette.accent, "#0284c7", "#0369a1");

    const beaconTop = isoProject(0, 0, 158 * buildIn, isoOx, isoOy);
    for (let r = 0; r < 3; r++) {
      const ringProg = (sceneProgress * 2.4 + r * 0.33) % 1;
      ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - ringProg) * 0.85})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(beaconTop.x, beaconTop.y, 26 + ringProg * 175, 14 + ringProg * 95, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (showAnimals) {
      drawIsoAnimal(ctx, -120 + sceneProgress * 75, -25, 0, isoOx, isoOy, {
        bodyTop: "#f97316",
        bodyLeft: "#ea580c",
        bodyRight: "#c2410c",
        stripes: true,
        gpsCollar: true,
        walking: true,
        walkPhase: sceneProgress * 16,
        scale: 1.05,
      });
    }
    if (showPeople) {
      drawIsoPerson(ctx, -95, 85, 0, isoOx, isoOy, {
        shirtTop: palette.secondary,
        shirtLeft: "#ea580c",
        shirtRight: "#c2410c",
        raiseArm: true,
        scale: 0.9,
      });
      drawIsoPerson(ctx, 95, 85, 0, isoOx, isoOy, {
        shirtTop: palette.tertiary,
        shirtLeft: "#16a34a",
        shirtRight: "#15803d",
        raiseArm: true,
        scale: 0.9,
      });
    }

    const nodes = [
      { ix: -140, iy: -120, lbl: metrics[0]!, c: palette.tertiary },
      { ix: 110, iy: -120, lbl: metrics[1] || metrics[0]!, c: palette.accent },
      { ix: 0, iy: 120, lbl: metrics[2] || metrics[0]!, c: palette.secondary },
    ];
    nodes.forEach((nd) => {
      drawIsoBox(ctx, nd.ix - 26, nd.iy - 26, 0, 52, 52, 48 * buildIn, isoOx, isoOy, nd.c, "#1e293b", "#0f172a");
      const np = isoProject(nd.ix, nd.iy, 66 * buildIn, isoOx, isoOy);
      drawIsoPillLabel(ctx, np.x, np.y, nd.lbl, nd.c);
    });
  } else if (archetype === "conveyor_sorter") {
    drawIsoBox(ctx, -225, -110, -14, 450, 220, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -205, -42, 0, 410, 84, 34 * buildIn, isoOx, isoOy, "#475569", "#334155", "#1e293b");
    drawIsoBox(ctx, -18, -56, 34 * buildIn, 36, 112, 92 * buildIn, isoOx, isoOy, palette.accent, "#0284c7", "#0369a1");

    for (let c = 0; c < 3; c++) {
      const beltProg = (sceneProgress * 1.4 + c * 0.33) % 1;
      const cxPos = -185 + beltProg * 330;
      const passedScanner = cxPos > 0;
      drawIsoBox(
        ctx,
        cxPos,
        -24,
        34 * buildIn,
        46,
        48,
        42 * buildIn,
        isoOx,
        isoOy,
        passedScanner ? palette.tertiary : palette.secondary,
        passedScanner ? "#059669" : "#e11d48",
        passedScanner ? "#047857" : "#be123c"
      );
    }

    if (showPeople) {
      drawIsoPerson(ctx, 130, 75, 0, isoOx, isoOy, {
        shirtTop: palette.accent,
        shirtLeft: "#0284c7",
        shirtRight: "#0369a1",
        raiseArm: true,
        scale: 0.92,
      });
    }

    const archLbl = isoProject(0, 0, 148 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, archLbl.x, archLbl.y, metrics[0]!, palette.accent);
  } else if (archetype === "value_pillars") {
    drawIsoBox(ctx, -205, -135, -14, 410, 270, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    const count = Math.max(2, metrics.length);
    const heights = [75, 145, 215];
    const colors = [
      { top: palette.accent, left: "#0284c7", right: "#0369a1" },
      { top: palette.secondary, left: "#e11d48", right: "#be123c" },
      { top: palette.tertiary, left: "#059669", right: "#047857" },
    ];
    for (let i = 0; i < count; i++) {
      const ix = -140 + i * 115;
      const pillarGrowth = easeOutCubic(Math.min(1, Math.max(0.15, sceneProgress * 1.4 - i * 0.14)));
      const ph = heights[i]! * pillarGrowth;
      const col = colors[i]!;
      drawIsoBox(ctx, ix, -42, 0, 78, 84, ph, isoOx, isoOy, col.top, col.left, col.right);
      const cap = isoProject(ix + 39, 0, ph + 26, isoOx, isoOy);
      drawIsoPillLabel(ctx, cap.x, cap.y, metrics[i]!, col.top);
    }
  } else if (archetype === "core_cutaway") {
    drawIsoBox(ctx, -170, -170, -14, 340, 340, 14, isoOx, isoOy, "#1e293b", "#0f172a", "#020617");
    drawIsoBox(ctx, -125, -125, 0, 250, 250, 56 * buildIn, isoOx, isoOy, palette.accent, "#0284c7", "#0369a1");
    drawIsoBox(ctx, -82, -82, 46 * buildIn, 164, 164, 62 * buildIn, isoOx, isoOy, palette.tertiary, "#059669", "#047857");
    const liftZ = 115 * buildIn + Math.sin(sceneProgress * Math.PI) * 28;
    drawIsoBox(ctx, -44, -44, liftZ, 88, 88, 70 * buildIn, isoOx, isoOy, palette.secondary, "#e11d48", "#be123c");
    const cap = isoProject(0, 0, liftZ + 94 * buildIn, isoOx, isoOy);
    drawIsoPillLabel(ctx, cap.x, cap.y, metrics[0]!, palette.secondary);
  } else {
    drawIsoBox(ctx, -190, -190, -14, 380, 380, 14, isoOx, isoOy, "#0f172a", "#090d16", "#020617");
    drawIsoBox(ctx, -50, -50, 0, 100, 100, 118 * buildIn, isoOx, isoOy, palette.accent, "#0284c7", "#0369a1");
    const orbiters = [
      { angle: sceneProgress * Math.PI * 1.5, c: palette.secondary, lbl: metrics[0]! },
      { angle: sceneProgress * Math.PI * 1.5 + (Math.PI * 2) / 3, c: palette.tertiary, lbl: metrics[1] || metrics[0]! },
      { angle: sceneProgress * Math.PI * 1.5 + (Math.PI * 4) / 3, c: palette.accent, lbl: metrics[2] || metrics[0]! },
    ];
    orbiters.forEach((orb, idx) => {
      const ox = Math.cos(orb.angle) * 145;
      const oy = Math.sin(orb.angle) * 145;
      drawIsoBox(ctx, ox - 28, oy - 28, 0, 56, 56, 64 * buildIn, isoOx, isoOy, orb.c, "#1e293b", "#0f172a");
      if (idx < metrics.length) {
        const op = isoProject(ox, oy, 82 * buildIn, isoOx, isoOy);
        drawIsoPillLabel(ctx, op.x, op.y, orb.lbl, orb.c);
      }
    });
  }

  ctx.restore();

  // 5. Lower-Third Clean Metric Cards
  const cardCount = metrics.length;
  const cardGap = 24;
  const sidePad = 56;
  const cardW = (w - sidePad * 2 - cardGap * (cardCount - 1)) / cardCount;
  const cardH = 210;
  const deckY = h * 0.73;
  const cardAccents = [palette.accent, palette.secondary, palette.tertiary];

  metrics.forEach((metricLabel, idx) => {
    const cardReveal = easeOutCubic(Math.min(1, Math.max(0, (sceneProgress - idx * 0.08) / 0.25)));
    const barFill = Math.min(1, 0.35 + sceneProgress * 0.65);
    const x = sidePad + idx * (cardW + cardGap);
    const y = deckY + (1 - cardReveal) * 22;

    ctx.save();
    ctx.globalAlpha = 0.2 + 0.8 * cardReveal;
    drawRoundedRect(ctx, x, y, cardW, cardH, 22);
    ctx.fillStyle = "rgba(11, 18, 32, 0.90)";
    ctx.fill();
    ctx.strokeStyle = cardAccents[idx % cardAccents.length]!;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = cardAccents[idx % cardAccents.length]!;
    ctx.font = "900 15px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`0${idx + 1}`, x + 24, y + 36);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
    const lines = wrapTextLines(ctx, metricLabel.toUpperCase(), cardW - 48, 3);
    lines.forEach((ln, li) => {
      ctx.fillText(ln, x + 24, y + 72 + li * 26);
    });

    const barY = y + cardH - 34;
    const trackW = cardW - 48;
    drawRoundedRect(ctx, x + 24, barY, trackW, 10, 5);
    ctx.fillStyle = "#1e293b";
    ctx.fill();

    drawRoundedRect(ctx, x + 24, barY, Math.max(12, trackW * barFill), 10, 5);
    ctx.fillStyle = cardAccents[idx % cardAccents.length]!;
    ctx.fill();
    ctx.restore();
  });
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
  const entrance = easeOutBack(Math.min(1, progress * 3.4));
  const reveal = easeOutCubic(Math.min(1, progress * 2.1));
  const m0 = (metrics[0] || "STEP 1").slice(0, 26);
  const m1 = (metrics[1] || "STEP 2").slice(0, 26);
  const m2 = (metrics[2] || "RESULT").slice(0, 26);
  const title = (propTitle || "BREAKDOWN").toUpperCase().slice(0, 32);

  ctx.save();
  ctx.translate(px, py + Math.sin(t * 2.6) * 5);
  ctx.scale(0.84 + 0.16 * entrance, 0.84 + 0.16 * entrance);

  const cardW = 470;
  const cardH = 350;

  // Board Backdrop with comic shadow
  if (!darkTheme) {
    ctx.fillStyle = "rgba(15, 23, 42, 0.18)";
    drawRoundedRect(ctx, -cardW / 2 + 10, -cardH / 2 + 12, cardW, cardH, 26);
    ctx.fill();
  }
  drawRoundedRect(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 26);
  ctx.fillStyle = darkTheme ? "rgba(15, 23, 42, 0.94)" : "#ffffff";
  ctx.fill();
  ctx.strokeStyle = darkTheme ? "#22d3ee" : "#0f172a";
  ctx.lineWidth = darkTheme ? 3.5 : 6;
  ctx.stroke();

  // Header Banner
  const headerColors: Record<string, string> = {
    comparison_bars: "#2563eb",
    flow_network: "#7c3aed",
    parallel_grid: "#059669",
    magnifying_lens: "#d97706",
    growth_chart: "#0284c7",
  };
  drawRoundedRect(ctx, -cardW / 2 + 16, -cardH / 2 + 16, cardW - 32, 44, 14);
  ctx.fillStyle = darkTheme ? "rgba(34, 211, 238, 0.16)" : (headerColors[propType] || "#2563eb");
  ctx.fill();

  ctx.fillStyle = darkTheme ? "#22d3ee" : "#ffffff";
  ctx.font = "bold 18px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, 0, -cardH / 2 + 44);

  if (propType === "comparison_bars") {
    // Animated 3-column rising bar chart with value badges
    const bars = [
      { x: -135, targetH: 85, color: "#f97316", lbl: m0 },
      { x: 0, targetH: 135, color: "#3b82f6", lbl: m1 },
      { x: 135, targetH: 195, color: "#22c55e", lbl: m2 },
    ];
    const baseY = 105;
    ctx.strokeStyle = darkTheme ? "#334155" : "#cbd5e1";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-195, baseY);
    ctx.lineTo(195, baseY);
    ctx.stroke();

    bars.forEach((b, i) => {
      const hNow = b.targetH * Math.min(1, reveal * (1.25 - i * 0.15));
      drawRoundedRect(ctx, b.x - 38, baseY - hNow, 76, Math.max(8, hNow), 10);
      ctx.fillStyle = b.color;
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 3.5;
      ctx.stroke();

      ctx.fillStyle = darkTheme ? "#f8fafc" : "#0f172a";
      ctx.font = "bold 14px 'Segoe UI', Arial, sans-serif";
      const lines = wrapTextLines(ctx, b.lbl, 125, 2);
      lines.forEach((ln, li) => ctx.fillText(ln, b.x, baseY + 24 + li * 17));
    });
  } else if (propType === "flow_network" || propType === "magnifying_lens") {
    // Stacked horizontal process pills with directional arrows
    const rows = [
      { y: -58, color: "#fef3c7", border: "#f59e0b", badge: "01", lbl: m0 },
      { y: 18, color: "#e0e7ff", border: "#4f46e5", badge: "02", lbl: m1 },
      { y: 94, color: "#dcfce7", border: "#16a34a", badge: "03", lbl: m2 },
    ];
    rows.forEach((r, i) => {
      const alpha = Math.max(0.15, Math.min(1, reveal * 2.2 - i * 0.45));
      ctx.save();
      ctx.globalAlpha = alpha;
      drawRoundedRect(ctx, -195, r.y - 26, 390, 52, 14);
      ctx.fillStyle = darkTheme ? "rgba(30, 41, 59, 0.9)" : r.color;
      ctx.fill();
      ctx.strokeStyle = darkTheme ? "#22d3ee" : r.border;
      ctx.lineWidth = 3;
      ctx.stroke();

      // Number circle
      ctx.fillStyle = r.border;
      ctx.beginPath();
      ctx.arc(-162, r.y, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 13px 'Segoe UI', Arial, sans-serif";
      ctx.fillText(r.badge, -162, r.y + 5);

      ctx.fillStyle = darkTheme ? "#f8fafc" : "#0f172a";
      ctx.font = "bold 16px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(r.lbl.slice(0, 26), -134, r.y + 6);
      ctx.textAlign = "center";
      ctx.restore();
    });
  } else if (propType === "parallel_grid") {
    // 3 Metric Tiles with circular gauges
    const tiles = [
      { x: -138, accent: "#3b82f6", pct: 0.45, lbl: m0 },
      { x: 0, accent: "#f59e0b", pct: 0.72, lbl: m1 },
      { x: 138, accent: "#10b981", pct: 0.95, lbl: m2 },
    ];
    tiles.forEach((tile) => {
      drawRoundedRect(ctx, tile.x - 62, -75, 124, 210, 16);
      ctx.fillStyle = darkTheme ? "rgba(30, 41, 59, 0.85)" : "#f8fafc";
      ctx.fill();
      ctx.strokeStyle = darkTheme ? "#334155" : "#cbd5e1";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Ring gauge
      ctx.strokeStyle = darkTheme ? "#1e293b" : "#e2e8f0";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(tile.x, -12, 34, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = tile.accent;
      ctx.beginPath();
      ctx.arc(tile.x, -12, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * tile.pct * reveal);
      ctx.stroke();

      ctx.fillStyle = darkTheme ? "#f8fafc" : "#0f172a";
      ctx.font = "bold 15px 'Segoe UI', Arial, sans-serif";
      const lines = wrapTextLines(ctx, tile.lbl, 112, 3);
      lines.forEach((ln, li) => ctx.fillText(ln, tile.x, 56 + li * 19));
    });
  } else {
    // Growth chart with area fill and wrapped multi-line labels
    const pts = [
      { x: -145, y: 74, lbl: m0 },
      { x: 0, y: 8, lbl: m1 },
      { x: 145, y: -64, lbl: m2 },
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
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2);
        ctx.fill();
        if (!darkTheme) ctx.stroke();

        ctx.fillStyle = darkTheme ? "#e2e8f0" : "#0f172a";
        ctx.font = "bold 15px 'Segoe UI', Arial, sans-serif";
        ctx.textAlign = "center";
        const lines = wrapTextLines(ctx, pt.lbl, 130, 2);
        lines.forEach((ln, li) => ctx.fillText(ln, pt.x, pt.y + 32 + li * 18));
      }
    });
  }

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
  const storyCue = inferStoryDrivenAction(beat, sceneIdx, sceneCount);
  const action = storyCue.action;
  const pos = beat.position || (sceneIdx % 2 === 0 ? "left" : "right");
  const propType = storyCue.propType;
  const propTitle = beat.propTitle || beat.beatSummary || "KEY CONCEPT";
  const propMetrics = beat.propMetrics && beat.propMetrics.length > 0 ? beat.propMetrics : ["BEFORE", "PROCESS", "RESULT"];

  const isFinale = sceneIdx === sceneCount - 1 || action === "celebrating";

  // Rich environment progression across story beats
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
  const cy = h * 0.54;

  let charX = cx - 245;
  let charY = cy;
  let facing: 1 | -1 = 1;
  let propX = cx + 205;
  let propY = cy - 45;

  if (isFinale) {
    charX = cx;
    charY = cy + 35;
  } else if (pos === "right") {
    charX = cx + 245;
    facing = -1;
    propX = cx - 205;
  } else if (pos === "traverse" || action === "walking_across") {
    charX = w * 0.22 + easeOutCubic(sceneProgress) * (w * 0.56);
    propX = cx;
    propY = cy - 275;
  }

  if (!isFinale) {
    drawDynamicProp(ctx, propType, propTitle, propMetrics, propX, propY, t, sceneProgress, false);
  } else {
    // Finale floating achievement banner + falling gold coins
    drawDynamicProp(ctx, "parallel_grid", propTitle, propMetrics, cx, cy - 290, t, sceneProgress, false);
    for (let c = 0; c < 14; c++) {
      const coinX = ((c * 173 + t * 90) % (w - 120)) + 60;
      const coinY = ((c * 241 + t * 340) % (h * 0.72)) + 160;
      ctx.fillStyle = "#facc15";
      ctx.strokeStyle = "#854d0e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(coinX, coinY, 16, 16 * Math.abs(Math.cos(t * 5 + c)), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  const stride = t * 9.0;
  const gesture = Math.sin(t * 5.5);
  let rig: StickmanRig = {
    x: charX,
    y: charY + Math.sin(t * 4.0) * 5,
    scale: isFinale ? 1.06 : 0.95,
    facing,
    lookTargetX: isFinale ? 0 : 4,
    torsoLean: 0.06,
    leftShoulderAngle: 0.35,
    leftElbowAngle: -0.35,
    rightShoulderAngle: -1.35 + gesture * 0.25,
    rightElbowAngle: -0.25,
    leftHipAngle: 0.18,
    leftKneeAngle: 0,
    rightHipAngle: -0.18,
    rightKneeAngle: 0,
    expression: "happy",
    talking: true,
    accentRightArm: true,
  };

  if (isFinale) {
    const jump = Math.abs(Math.sin(t * 5.6));
    rig = {
      ...rig,
      y: charY - jump * 48,
      headTilt: Math.sin(t * 6) * 0.08,
      leftShoulderAngle: -2.55 - jump * 0.2,
      leftElbowAngle: -0.2,
      rightShoulderAngle: -2.55 - jump * 0.2,
      rightElbowAngle: 0.2,
      leftHipAngle: 0.35 + jump * 0.2,
      leftKneeAngle: -0.35 * jump,
      rightHipAngle: -0.35 - jump * 0.2,
      rightKneeAngle: 0.35 * jump,
      expression: "excited",
    };
  } else if (action === "walking_across") {
    rig = {
      ...rig,
      y: charY - Math.abs(Math.sin(stride)) * 15,
      torsoLean: 0.16,
      leftShoulderAngle: Math.sin(stride) * 0.72,
      leftElbowAngle: -0.45,
      rightShoulderAngle: -Math.sin(stride) * 0.72,
      rightElbowAngle: -0.55,
      leftHipAngle: -Math.sin(stride) * 0.64,
      leftKneeAngle: Math.max(0, Math.sin(stride) * 0.82),
      rightHipAngle: Math.sin(stride) * 0.64,
      rightKneeAngle: Math.max(0, -Math.sin(stride) * 0.82),
      expression: "happy",
    };
  } else if (action === "thinking") {
    // Hand raised to chin, head tilted upward, skeptical thinking brow
    rig = {
      ...rig,
      torsoLean: -0.05,
      headTilt: -0.12 + Math.sin(t * 2.5) * 0.04,
      lookTargetX: 2,
      leftShoulderAngle: 0.25,
      leftElbowAngle: -0.8,
      rightShoulderAngle: -0.85,
      rightElbowAngle: -1.85 + Math.sin(t * 3.5) * 0.08,
      expression: "thinking",
    };
  } else if (action === "directing_swarm") {
    // Dynamic two-handed emphatic explanation
    rig = {
      ...rig,
      torsoLean: 0.11,
      headTilt: gesture * 0.07,
      leftShoulderAngle: -0.95 - gesture * 0.35,
      leftElbowAngle: -0.65,
      rightShoulderAngle: -1.45 + gesture * 0.35,
      rightElbowAngle: -0.45,
      leftHipAngle: 0.24,
      rightHipAngle: -0.24,
      expression: "excited",
    };
  } else if (action === "examining_lens") {
    // Leaning forward intently inspecting the data board
    rig = {
      ...rig,
      torsoLean: 0.22,
      headTilt: 0.09,
      lookTargetX: 4.5,
      leftShoulderAngle: 0.45,
      leftElbowAngle: -0.3,
      rightShoulderAngle: -1.15 + Math.sin(t * 4.5) * 0.15,
      rightElbowAngle: -0.95,
      leftHipAngle: 0.28,
      leftKneeAngle: 0.18,
      rightHipAngle: -0.15,
      expression: "thinking",
    };
  }

  drawArticulatedStickman(ctx, rig, t);
}

function extractProductModelInfo(title: string, script: string): {
  fullQuery: string;
  brand: string;
  modelCode: string;
} {
  const combined = `${title} ${script}`;
  // Extract exact alphanumeric model code (e.g. GA-2100, F-91W, WH-1000XM5, S24, 16 Pro)
  const codeMatch = combined.match(/\b([A-Z]{1,4}-?\d{2,4}[A-Z0-9-]*|\d{2,4}[A-Z]{1,3})\b/);
  const brandMatch = combined.match(
    /\b(Casio|G-Shock|Seiko|Rolex|Timex|Apple|iPhone|Samsung|Galaxy|Sony|Bose|Nothing|OnePlus|DJI|GoPro|Asus|Lenovo|Nike|Adidas)\b/i
  );
  const brand = brandMatch ? brandMatch[1]! : "";
  const modelCode = codeMatch ? codeMatch[1]!.toUpperCase() : "";
  const fullQuery = [brand, modelCode].filter(Boolean).join(" ") ||
    title.replace(/review|unboxing|worth it|honest|full|why this|iconic/gi, "").trim() ||
    title;

  return { fullQuery, brand, modelCode };
}

async function fetchStyleVisualImages(
  style: VideoStyleId,
  title: string,
  script: string,
  keywords: string[],
  count: number
): Promise<Image[]> {
  if (style !== "stock_ken_burns" && style !== "phonk_montage_edit" && style !== "product_review_showcase") {
    return [];
  }

  let queries: string[] = [];
  let requiredModelToken = "";

  if (style === "product_review_showcase") {
    const info = extractProductModelInfo(title, script);
    requiredModelToken = info.modelCode.replace(/[^A-Z0-9]/g, "");
    queries = [
      `${info.fullQuery}`,
      `${info.brand} ${info.modelCode} watch`.trim(),
      `${info.fullQuery} CasiOak`,
    ];
  } else if (style === "phonk_montage_edit") {
    const theme = keywords[0] || title.split(/[:|-]/)[0] || "cyberpunk anime";
    queries = [
      `${theme} dark aesthetic neon`,
      "tokyo night neon rain aesthetic",
      "dark samurai anime aesthetic wallpaper",
    ];
  } else {
    const cleanTopic = title.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
    queries = [
      cleanTopic,
      ...(keywords.slice(0, 3).map((k) => `${k} editorial photo`)),
    ];
  }

  const loaded: Image[] = [];
  const seenUrls = new Set<string>();

  const matchesExactModel = (metaText: string): boolean => {
    if (!requiredModelToken || requiredModelToken.length < 3) return true;
    const norm = metaText.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (norm.includes(requiredModelToken)) return true;
    // Also allow "CASIOAK" for GA-2100
    if (requiredModelToken === "GA2100" && norm.includes("CASIOAK")) return true;
    return false;
  };

  for (const q of queries) {
    if (loaded.length >= count) break;

    // 1) Query Wikimedia Commons API first (highest-accuracy exact model photos)
    try {
      const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size&iiurlwidth=1080&format=json&origin=*`;
      const wResp = await fetch(wikiUrl, {
        headers: { "User-Agent": "ContentOS-MediaEngine/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (wResp.ok) {
        const wData = (await wResp.json()) as {
          query?: { pages?: Record<string, { title?: string; imageinfo?: Array<{ thumburl?: string; url?: string }> }> };
        };
        const pages = Object.values(wData.query?.pages ?? {});
        for (const page of pages) {
          if (loaded.length >= count) break;
          const pTitle = page.title ?? "";
          if (!matchesExactModel(pTitle)) continue;
          const imgUrl = page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url;
          if (!imgUrl || seenUrls.has(imgUrl) || /\.svg$/i.test(imgUrl)) continue;
          seenUrls.add(imgUrl);
          try {
            const img = await loadImage(imgUrl);
            if (img.width >= 320 && img.height >= 260) loaded.push(img);
          } catch {}
        }
      }
    } catch {}

    // 2) Query Openverse with strict model-token filtering on title/tags
    try {
      const ovUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=15`;
      const resp = await fetch(ovUrl, {
        headers: { "User-Agent": "ContentOS-MediaEngine/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{ url?: string; thumbnail?: string; title?: string; tags?: Array<{ name?: string }> }>;
        };
        for (const item of data.results ?? []) {
          if (loaded.length >= count) break;
          const tagStr = (item.tags ?? []).map((t) => t.name ?? "").join(" ");
          const meta = `${item.title ?? ""} ${tagStr} ${item.url ?? ""}`;
          if (!matchesExactModel(meta)) continue;

          const imgUrl = item.url || item.thumbnail;
          if (!imgUrl || seenUrls.has(imgUrl) || /\.svg$/i.test(imgUrl)) continue;
          seenUrls.add(imgUrl);
          try {
            const img = await loadImage(imgUrl);
            if (img.width >= 320 && img.height >= 260) loaded.push(img);
          } catch {}
        }
      }
    } catch {}
  }

  // Only fall back to generic stock images for non-product-review modes so wrong watch models NEVER pollute a product review
  if (style !== "product_review_showcase" && loaded.length < Math.min(2, count)) {
    const fallback = await fetchStockImages(queries[0] || title, keywords, count);
    loaded.push(...fallback);
  }

  return loaded;
}

function inferStoryDrivenAction(beat: DynamicStoryboardBeat, sceneIdx: number, sceneCount: number): {
  action: string;
  cameraZoom: number;
  propType: string;
} {
  if (sceneIdx === sceneCount - 1) {
    return { action: "celebrating", cameraZoom: 1.06, propType: "parallel_grid" };
  }
  const text = `${beat.beatSummary || ""} ${beat.propTitle || ""} ${(beat.propMetrics || []).join(" ")}`.toLowerCase();

  if (/why|secret|question|cost|think|imagine|problem|trap|hidden/.test(text)) {
    return { action: "thinking", cameraZoom: 1.08, propType: "comparison_bars" };
  }
  if (/step|chain|supply|move|transit|deliver|flow|pipeline|street|tier/.test(text)) {
    return { action: "walking_across", cameraZoom: 1.0, propType: "flow_network" };
  }
  if (/profit|billion|million|lakh|crore|scale|volume|multiply|massive/.test(text)) {
    return { action: "directing_swarm", cameraZoom: 1.05, propType: "parallel_grid" };
  }
  if (/detail|margin|percent|check|inspect|audit|data|proof|number/.test(text)) {
    return { action: "examining_lens", cameraZoom: 1.1, propType: "magnifying_lens" };
  }
  const fallbackActions = ["presenting_board", "thinking", "directing_swarm", "examining_lens"];
  const fallbackProps = ["growth_chart", "comparison_bars", "flow_network", "parallel_grid"];
  return {
    action: beat.action || fallbackActions[sceneIdx % fallbackActions.length]!,
    cameraZoom: sceneIdx % 2 === 0 ? 1.0 : 1.07,
    propType: beat.propType || fallbackProps[sceneIdx % fallbackProps.length]!,
  };
}

function renderPhonkMontageScene(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  t: number,
  beat: DynamicStoryboardBeat,
  sceneIdx: number,
  sceneProgress: number,
  images: Image[]
): void {
  // High-energy Phonk / Anime AMV edit: rhythmic bass-hit pulse, speed-ramp zoom, RGB split & letterbox
  const beatFreq = 2.15; // ~129 BPM phonk pulse
  const beatPhase = (t * beatFreq) % 1;
  const bassHit = Math.pow(Math.max(0, 1 - beatPhase * 3.5), 2);
  const shakeX = bassHit * Math.sin(t * 95) * 18;
  const shakeY = bassHit * Math.cos(t * 82) * 14;
  const speedRampZoom = 1.08 + easeOutCubic(Math.min(1, sceneProgress * 2.5)) * 0.14 + bassHit * 0.08;

  ctx.save();
  ctx.translate(w * 0.5 + shakeX, h * 0.5 + shakeY);
  ctx.scale(speedRampZoom, speedRampZoom);

  if (images.length > 0) {
    const img = images[sceneIdx % images.length]!;
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);

    // Chromatic RGB flash overlay on bass hit
    if (bassHit > 0.25) {
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = bassHit * 0.32;
      ctx.drawImage(img, -dw / 2 - 14 * bassHit, -dh / 2, dw, dh);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  } else {
    // High-contrast Crimson / Indigo Cyber-Anime Speedline Backdrop
    const bg = ctx.createRadialGradient(0, 0, 40, 0, 0, h * 0.7);
    bg.addColorStop(0, sceneIdx % 2 === 0 ? "#4c0519" : "#1e1b4b");
    bg.addColorStop(1, "#030305");
    ctx.fillStyle = bg;
    ctx.fillRect(-w / 2, -h / 2, w, h);

    // Manga Action Speedlines
    ctx.strokeStyle = sceneIdx % 2 === 0 ? "rgba(244, 63, 94, 0.35)" : "rgba(129, 140, 248, 0.35)";
    ctx.lineWidth = 3;
    for (let i = 0; i < 48; i++) {
      const ang = (i / 48) * Math.PI * 2 + t * 0.3;
      const rIn = 180 + ((i * 37 + t * 400) % 160);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * rIn, Math.sin(ang) * rIn);
      ctx.lineTo(Math.cos(ang) * h * 0.9, Math.sin(ang) * h * 0.9);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Dark Moody Contrast Vignette + Flash Frame on Scene Cut
  const vig = ctx.createLinearGradient(0, 0, 0, h);
  vig.addColorStop(0, "rgba(0, 0, 0, 0.86)");
  vig.addColorStop(0.5, "rgba(0, 0, 0, 0.28)");
  vig.addColorStop(1, "rgba(0, 0, 0, 0.92)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  if (sceneProgress < 0.08) {
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.08 - sceneProgress) * 5.5})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Center Impact Keyword Stamp
  const stamp = (beat.propTitle || beat.beatSummary || "UNSTOPPABLE").toUpperCase().slice(0, 24);
  ctx.save();
  ctx.translate(w * 0.5, h * 0.44);
  ctx.scale(1 + bassHit * 0.09, 1 + bassHit * 0.09);
  ctx.font = "900 66px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(244, 63, 94, 0.75)";
  ctx.fillText(stamp, -5 * bassHit, 0);
  ctx.fillStyle = "rgba(56, 189, 248, 0.75)";
  ctx.fillText(stamp, 5 * bassHit, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(stamp, 0, 0);
  ctx.restore();

  // Cinematic Letterbox Bars
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, 95);
  ctx.fillRect(0, h - 95, w, 95);
}

function renderProductReviewScene(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  t: number,
  title: string,
  beat: DynamicStoryboardBeat,
  sceneIdx: number,
  sceneCount: number,
  sceneProgress: number,
  images: Image[]
): void {
  const isFinalVerdict = sceneIdx === sceneCount - 1;
  const layoutMode = isFinalVerdict ? 3 : sceneIdx % 3;

  // Deep Carbon Studio Backdrop
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#05070d");
  bg.addColorStop(0.5, "#0d1322");
  bg.addColorStop(1, "#04060b");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Subtle architectural studio grid lines
  ctx.strokeStyle = "rgba(245, 158, 11, 0.06)";
  ctx.lineWidth = 1.5;
  for (let gx = 0; gx <= w; gx += 90) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h);
    ctx.stroke();
  }

  // Warm Gold / Amber Rim Spotlight
  const glow = ctx.createRadialGradient(w * 0.5, h * 0.44, 20, w * 0.5, h * 0.44, 520);
  glow.addColorStop(0, "rgba(245, 158, 11, 0.28)");
  glow.addColorStop(0.55, "rgba(234, 88, 12, 0.08)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const img = images.length > 0 ? images[sceneIdx % images.length]! : null;
  const rawTitle = (beat.propTitle || "").trim();
  const sectionTag =
    !rawTitle || /^PHASE\s*\d/i.test(rawTitle)
      ? ["DESIGN & BUILD", "KEY SPECS", "DAILY PERFORMANCE", "FINAL VERDICT"][sceneIdx % 4]!
      : rawTitle.toUpperCase().slice(0, 26);

  const rawMetrics = (beat.propMetrics ?? []).filter((m) => m && !/^PHASE\s*\d/i.test(m.trim()));
  const specs =
    rawMetrics.length > 0
      ? rawMetrics.slice(0, 3)
      : ["200M WATER RESIST", "CARBON CORE GUARD", "UNDER ?10,000"];

  const entrance = easeOutCubic(Math.min(1, sceneProgress * 3.0));
  const floatY = Math.sin(t * 2.3) * 8;

  if (layoutMode === 0) {
    // LAYOUT 0: Full-Bleed Dramatic Hero Macro Reveal with Gold Rim Frame
    const cardW = 860;
    const cardH = 660;
    const cardX = (w - cardW) / 2;
    const cardY = h * 0.21 + floatY;
    const zoom = 1.02 + sceneProgress * 0.14;

    ctx.save();
    drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 36);
    ctx.fillStyle = "#0f172a";
    ctx.fill();
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 4;
    ctx.stroke();

    if (img) {
      ctx.save();
      drawRoundedRect(ctx, cardX + 6, cardY + 6, cardW - 12, cardH - 12, 30);
      ctx.clip();
      const scale = Math.max(cardW / img.width, cardH / img.height) * zoom;
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, w * 0.5 - dw / 2, cardY + cardH * 0.5 - dh / 2, dw, dh);

      // Cinematic bottom gradient inside hero frame
      const grad = ctx.createLinearGradient(0, cardY + cardH * 0.45, 0, cardY + cardH);
      grad.addColorStop(0, "rgba(5, 7, 13, 0)");
      grad.addColorStop(1, "rgba(5, 7, 13, 0.92)");
      ctx.fillStyle = grad;
      ctx.fillRect(cardX, cardY, cardW, cardH);
      ctx.restore();
    }

    // Hero Spec Overlay inside bottom of card
    drawRoundedRect(ctx, cardX + 32, cardY + 28, 290, 44, 22);
    ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
    ctx.fill();
    ctx.fillStyle = "#090d16";
    ctx.font = "900 18px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(sectionTag, cardX + 177, cardY + 56);

    ctx.fillStyle = "#ffffff";
    ctx.font = "900 34px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText((specs[0] || "ICONIC DESIGN").toUpperCase().slice(0, 28), cardX + 36, cardY + cardH - 36);
    ctx.restore();
  } else if (layoutMode === 1) {
    // LAYOUT 1: Interactive Blueprint Callout Pointers Around Product
    const cardW = 620;
    const cardH = 540;
    const cardX = (w - cardW) / 2;
    const cardY = h * 0.22 + floatY;
    const zoom = 1.08 - sceneProgress * 0.08;

    drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 32);
    ctx.fillStyle = "#111827";
    ctx.fill();
    ctx.strokeStyle = "rgba(245, 158, 11, 0.65)";
    ctx.lineWidth = 3.5;
    ctx.stroke();

    if (img) {
      ctx.save();
      drawRoundedRect(ctx, cardX + 8, cardY + 8, cardW - 16, cardH - 16, 26);
      ctx.clip();
      const scale = Math.max(cardW / img.width, cardH / img.height) * zoom;
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, w * 0.5 - dw / 2, cardY + cardH * 0.5 - dh / 2, dw, dh);
      ctx.restore();
    }

    // Animated Technical Callout Badges along bottom of frame
    const pillW = 285;
    const pillH = 74;
    const gap = 24;
    const rowY = cardY + cardH + 28;
    const showSpecs = specs.slice(0, 3);
    const totalW = showSpecs.length * pillW + (showSpecs.length - 1) * gap;
    const startX = (w - totalW) / 2;

    showSpecs.forEach((sp, i) => {
      const alpha = Math.max(0.2, Math.min(1, entrance * 1.6 - i * 0.25));
      ctx.save();
      ctx.globalAlpha = alpha;
      const px = startX + i * (pillW + gap);
      drawRoundedRect(ctx, px, rowY, pillW, pillH, 18);
      ctx.fillStyle = "rgba(15, 23, 42, 0.95)";
      ctx.fill();
      ctx.strokeStyle = i === 0 ? "#f59e0b" : "#38bdf8";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = i === 0 ? "#fbbf24" : "#38bdf8";
      ctx.font = "bold 13px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`SPEC 0${i + 1}`, px + pillW / 2, rowY + 25);

      ctx.fillStyle = "#f8fafc";
      ctx.font = "900 19px 'Segoe UI', Arial, sans-serif";
      ctx.fillText(sp.toUpperCase().slice(0, 20), px + pillW / 2, rowY + 54);
      ctx.restore();
    });
  } else if (layoutMode === 2) {
    // LAYOUT 2: Split Hardware Card (Left Product Close-Up + Right Animated Spec Meters)
    const panelY = h * 0.22 + floatY;
    const panelH = 610;

    // Left Photo Card
    const leftX = 64;
    const leftW = 470;
    drawRoundedRect(ctx, leftX, panelY, leftW, panelH, 28);
    ctx.fillStyle = "#111827";
    ctx.fill();
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 3.5;
    ctx.stroke();

    if (img) {
      ctx.save();
      drawRoundedRect(ctx, leftX + 6, panelY + 6, leftW - 12, panelH - 12, 24);
      ctx.clip();
      const scale = Math.max(leftW / img.width, panelH / img.height) * (1.05 + sceneProgress * 0.1);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, leftX + leftW * 0.5 - dw / 2, panelY + panelH * 0.5 - dh / 2, dw, dh);
      ctx.restore();
    }

    // Right Spec Breakdown Panel
    const rightX = 558;
    const rightW = 458;
    drawRoundedRect(ctx, rightX, panelY, rightW, panelH, 28);
    ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = "#fbbf24";
    ctx.font = "900 22px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(sectionTag, rightX + 32, panelY + 54);

    const meters = [
      { label: specs[0] || "BUILD DURABILITY", pct: 0.96, color: "#f59e0b" },
      { label: specs[1] || "DAILY COMFORT", pct: 0.91, color: "#38bdf8" },
      { label: specs[2] || "VALUE FOR MONEY", pct: 0.95, color: "#22c55e" },
    ];

    meters.forEach((m, idx) => {
      const my = panelY + 125 + idx * 155;
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 21px 'Segoe UI', Arial, sans-serif";
      ctx.fillText(m.label.toUpperCase().slice(0, 22), rightX + 32, my);

      // Meter track
      const trackW = rightW - 64;
      drawRoundedRect(ctx, rightX + 32, my + 22, trackW, 20, 10);
      ctx.fillStyle = "#1e293b";
      ctx.fill();

      // Animated meter fill
      const fillW = Math.max(20, trackW * m.pct * entrance);
      drawRoundedRect(ctx, rightX + 32, my + 22, fillW, 20, 10);
      ctx.fillStyle = m.color;
      ctx.fill();
    });
  } else {
    // LAYOUT 3: Final Verdict Card ("MUST BUY" Score + Hero Product)
    const cardW = 840;
    const cardH = 640;
    const cardX = (w - cardW) / 2;
    const cardY = h * 0.21 + floatY;

    drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 36);
    ctx.fillStyle = "#0f172a";
    ctx.fill();
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 5;
    ctx.stroke();

    if (img) {
      ctx.save();
      drawRoundedRect(ctx, cardX + 8, cardY + 8, cardW - 16, cardH - 16, 28);
      ctx.clip();
      const scale = Math.max(cardW / img.width, cardH / img.height) * (1.04 + sceneProgress * 0.1);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, w * 0.5 - dw / 2, cardY + cardH * 0.5 - dh / 2, dw, dh);

      const grad = ctx.createLinearGradient(0, cardY + cardH * 0.35, 0, cardY + cardH);
      grad.addColorStop(0, "rgba(5, 7, 13, 0.15)");
      grad.addColorStop(1, "rgba(5, 7, 13, 0.95)");
      ctx.fillStyle = grad;
      ctx.fillRect(cardX, cardY, cardW, cardH);
      ctx.restore();
    }

    // Verdict Score Badge
    drawRoundedRect(ctx, cardX + 36, cardY + cardH - 155, cardW - 72, 118, 22);
    ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
    ctx.fill();
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#22c55e";
    ctx.font = "900 22px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("FINAL VERDICT ? RECOMMENDED", cardX + 64, cardY + cardH - 108);

    ctx.fillStyle = "#ffffff";
    ctx.font = "900 32px 'Segoe UI', Arial, sans-serif";
    ctx.fillText((specs[specs.length - 1] || "UNBEATABLE DAILY VALUE").toUpperCase().slice(0, 30), cardX + 64, cardY + cardH - 60);

    // 9.5/10 Pill on right
    drawRoundedRect(ctx, cardX + cardW - 210, cardY + cardH - 134, 150, 76, 18);
    ctx.fillStyle = "#22c55e";
    ctx.fill();
    ctx.fillStyle = "#052e16";
    ctx.font = "900 32px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("9.5/10", cardX + cardW - 135, cardY + cardH - 85);
  }
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
  // Lock each visual beat window to actual caption/speech timestamps so visuals never lag behind voiceover
  const sceneWindows: Array<{ startSec: number; endSec: number }> = Array.from({ length: sceneCount }, (_, idx) => {
    const startCapIdx = Math.floor((idx / sceneCount) * syncedCaptions.length);
    const endCapIdx = Math.max(startCapIdx, Math.floor(((idx + 1) / sceneCount) * syncedCaptions.length) - 1);
    const startSec = idx === 0 ? 0 : (syncedCaptions[startCapIdx]?.startSec ?? idx * sceneDur);
    const endSec = idx === sceneCount - 1 ? safeDuration : (syncedCaptions[endCapIdx]?.endSec ?? (idx + 1) * sceneDur);
    return { startSec, endSec: Math.max(startSec + 0.5, endSec) };
  });

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

  const stockImages = await fetchStyleVisualImages(style, cleanTitle, cleanScript, params.keywords ?? [], Math.max(sceneCount, 4));

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
    let sceneIdx = sceneWindows.findIndex((win) => t >= win.startSec && t < win.endSec);
    if (sceneIdx === -1) sceneIdx = t < sceneWindows[0]!.startSec ? 0 : sceneCount - 1;
    const activeWin = sceneWindows[sceneIdx]!;
    const sceneProgress = Math.max(0, Math.min(1, (t - activeWin.startSec) / Math.max(0.25, activeWin.endSec - activeWin.startSec)));
    const activeBeat = aiBeats[sceneIdx]!;

    if (isIsometric) {
        renderIsometricTechScene(ctx, width, height, t, cleanTitle, activeBeat, sceneIdx, sceneCount, sceneProgress);
      } else if (isCartoonStickman) {
        renderDynamicStickmanScene(ctx, width, height, t, activeBeat, sceneIdx, sceneCount, sceneProgress);
      } else if (style === "minimal_line_art") {
        renderMinimalLineArtScene(ctx, width, height, t, activeBeat, sceneProgress);
      } else if (style === "phonk_montage_edit") {
        renderPhonkMontageScene(ctx, width, height, t, activeBeat, sceneIdx, sceneProgress, stockImages);
      } else if (style === "product_review_showcase") {
        renderProductReviewScene(ctx, width, height, t, cleanTitle, activeBeat, sceneIdx, sceneCount, sceneProgress, stockImages);
      } else if (style === "stock_ken_burns" && stockImages.length > 0) {
        const img = stockImages[sceneIdx % stockImages.length]!;
        const zoom = sceneIdx % 2 === 0 ? 1.0 + sceneProgress * 0.14 : 1.14 - sceneProgress * 0.14;
        const panX = (sceneIdx % 2 === 0 ? -1 : 1) * (sceneProgress - 0.5) * 45;
        const scale = Math.max(width / img.width, height / img.height) * zoom;
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (width - dw) / 2 + panX, (height - dh) / 2, dw, dh);

        const vig = ctx.createLinearGradient(0, 0, 0, height);
        vig.addColorStop(0, "rgba(9, 9, 11, 0.80)");
        vig.addColorStop(0.45, "rgba(9, 9, 11, 0.28)");
        vig.addColorStop(1, "rgba(9, 9, 11, 0.90)");
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, width, height);

        // Lower-third editorial topic pill
        const badgeText = (activeBeat.propTitle || activeBeat.beatSummary || "").toUpperCase().slice(0, 30);
        if (badgeText) {
          drawRoundedRect(ctx, width * 0.5 - 230, height * 0.70, 460, 46, 23);
          ctx.fillStyle = "rgba(99, 102, 241, 0.88)";
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(badgeText, width * 0.5, height * 0.70 + 30);
        }
      } else {
        renderMinimalLineArtScene(ctx, width, height, t, activeBeat, sceneProgress);
      }

      // Top Header Card (for non-isometric & non-cartoon styles)
    if (!isIsometric && !isCartoonStickman && style !== "phonk_montage_edit") {
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

    // Baked-in subtitles disabled (native platform captions handle CC cleanly without cluttering the lower third)

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
