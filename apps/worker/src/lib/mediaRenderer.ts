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
  | "stickman_explainer"
  | "minimal_line_art"
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
  rate: string;
  pitch: string;
  label: string;
} {
  if (explicitVoice) {
    return { voice: explicitVoice, rate: "+3%", pitch: "+0Hz", label: explicitVoice };
  }
  const t = (tone || "").toLowerCase();
  if (/energetic|hype|gaming|fast|bold|punchy/.test(t)) {
    return {
      voice: "en-US-BrianMultilingualNeural",
      rate: "+5%",
      pitch: "+2Hz",
      label: "Brian Multilingual Neural",
    };
  }
  if (/warm|story|calm|documentary|cinematic/.test(t)) {
    return {
      voice: "en-US-AvaMultilingualNeural",
      rate: "+0%",
      pitch: "-1Hz",
      label: "Ava Multilingual Neural",
    };
  }
  return {
    voice: "en-US-AndrewMultilingualNeural",
    rate: "+3%",
    pitch: "+1Hz",
    label: "Andrew Multilingual Neural",
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
}

function splitScriptIntoCaptionSegments(
  text: string,
  maxCharsPerLine: number,
  maxLinesPerCard: number
): Array<{ lines: string[]; spokenText: string }> {
  // Split on sentence boundaries and natural clause breaks (, ; ?) so each card is 1 complete spoken thought
  const rawClauses = text
    .split(/(?<=[.!?])\s+|(?<=[,;?])\s+(?=[A-Z0-9])/g)
    .map((c) => c.trim())
    .filter(Boolean);

  const segments: Array<{ lines: string[]; spokenText: string }> = [];

  for (const clause of rawClauses.length > 0 ? rawClauses : [text]) {
    const words = clause.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length <= maxCharsPerLine) {
        cur = (cur + " " + w).trim();
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);

    for (let i = 0; i < lines.length; i += maxLinesPerCard) {
      const slice = lines.slice(i, i + maxLinesPerCard);
      segments.push({
        lines: slice,
        spokenText: slice.join(" "),
      });
    }
  }

  return segments.length > 0
    ? segments
    : [{ lines: [text.slice(0, maxCharsPerLine)], spokenText: text }];
}

async function synthesizeSinglePhraseBuffer(
  phrase: string,
  voice: string,
  rate: string,
  pitch: string
): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await Promise.race([
    tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3),
    new Promise((_, reject) => setTimeout(() => reject(new Error("EdgeTTS metadata timeout")), 8000)),
  ]);

  const streamResult = tts.toStream(phrase, { rate, pitch }) as unknown as
    | { audioStream?: NodeJS.ReadableStream }
    | NodeJS.ReadableStream;

  const readable: NodeJS.ReadableStream =
    streamResult && typeof (streamResult as { audioStream?: unknown }).audioStream === "object"
      ? (streamResult as { audioStream: NodeJS.ReadableStream }).audioStream
      : (streamResult as NodeJS.ReadableStream);

  const parts: Buffer[] = [];
  return await Promise.race([
    new Promise<Buffer>((resolve, reject) => {
      readable.on("data", (d: Buffer | Uint8Array) => parts.push(Buffer.from(d)));
      readable.on("end", () => resolve(Buffer.concat(parts)));
      readable.on("error", reject);
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("EdgeTTS stream timeout")), 15000)),
  ]);
}

/**
 * Synthesizes expressive neural voiceover phrase-by-phrase, measures the exact
 * duration of every phrase via FFmpeg, and returns exact time-aligned caption
 * timestamps so captions NEVER drift out of sync with the voice!
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

  const isLandscape = params.aspectRatio === "16:9";
  const rawSegments = splitScriptIntoCaptionSegments(
    cleanText,
    isLandscape ? 46 : 27,
    isLandscape ? 3 : 3
  );

  const profile = pickNeuralVoiceAndProsody(params.tone, params.voice);
  const chunkFiles: string[] = [];
  const timedCaptions: TimedCaptionSegment[] = [];
  let cursorSec = 0;

  try {
    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i]!;
      // Add natural emphasis variation on hook (first) and CTA (last) sentences
      const segPitch = i === 0 ? "+2Hz" : i === rawSegments.length - 1 ? "+1Hz" : profile.pitch;
      const mp3Buf = await synthesizeSinglePhraseBuffer(
        seg.spokenText,
        profile.voice,
        profile.rate,
        segPitch
      );

      if (mp3Buf.byteLength < 600) {
        throw new Error(`EdgeTTS returned empty buffer for segment ${i}`);
      }

      const chunkMp3 = path.join(workDir, `voice_seg_${i}.mp3`);
      await fs.writeFile(chunkMp3, mp3Buf);
      chunkFiles.push(chunkMp3);

      const segDur = await probeDurationSec(
        chunkMp3,
        Math.max(1.2, seg.spokenText.split(/\s+/).length / 2.6)
      );
      timedCaptions.push({
        lines: seg.lines,
        spokenText: seg.spokenText,
        startSec: Number(cursorSec.toFixed(3)),
        endSec: Number((cursorSec + segDur).toFixed(3)),
      });
      cursorSec += segDur;
    }

    const rawVoicePath = path.join(workDir, "voice_raw.mp3");
    if (chunkFiles.length === 1) {
      await fs.copyFile(chunkFiles[0]!, rawVoicePath);
    } else {
      const concatListPath = path.join(workDir, "audio_concat.txt");
      const listBody = chunkFiles
        .map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n");
      await fs.writeFile(concatListPath, listBody, "utf8");
      await execFileAsync(ffmpegPath, [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c:a", "libmp3lame",
        "-b:a", "160k",
        rawVoicePath,
      ]);
      await fs.unlink(concatListPath).catch(() => {});
    }

    // Clean studio vocal mastering (warmth EQ + gentle broadcast compression, no synthetic drone)
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i", rawVoicePath,
      "-af", "highpass=f=80,equalizer=f=220:t=q:w=1.2:g=2.5,equalizer=f=3800:t=q:w=1.5:g=2.0,acompressor=threshold=-18dB:ratio=2.4:attack=12:release=160,alimiter=limit=0.95",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      fullPath,
    ]);

    await fs.unlink(rawVoicePath).catch(() => {});
    for (const cf of chunkFiles) {
      await fs.unlink(cf).catch(() => {});
    }

    const stat = await fs.stat(fullPath);
    const totalDuration = await probeDurationSec(fullPath, cursorSec);
    if (timedCaptions.length > 0) {
      timedCaptions[timedCaptions.length - 1]!.endSec = Number(totalDuration.toFixed(3));
    }

    return {
      fullPath,
      bytes: stat.size,
      durationSec: totalDuration,
      engine: `msedge-tts (${profile.label})`,
      cleanText,
      timedCaptions,
    };
  } catch (edgeErr) {
    for (const cf of chunkFiles) {
      await fs.unlink(cf).catch(() => {});
    }
    // Fallback to Windows SAPI with character-weighted caption timestamps
    const wavTemp = path.join(workDir, "sapi_temp.wav");
    const psScriptPath = path.join(workDir, "speak.ps1");
    const safeForPs = cleanText.replace(/'/g, "''");
    const psCode = [
      "Add-Type -AssemblyName System.Speech",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$synth.Rate = 1",
      "$synth.Volume = 100",
      `$synth.SetOutputToWaveFile('${wavTemp.replace(/'/g, "''")}')`,
      `$synth.Speak('${safeForPs}')`,
      "$synth.Dispose()",
    ].join("\n");

    try {
      await fs.writeFile(psScriptPath, psCode, "utf8");
      await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScriptPath]);
      await execFileAsync(ffmpegPath, [
        "-y",
        "-i", wavTemp,
        "-c:a", "libmp3lame",
        "-b:a", "160k",
        fullPath,
      ]);
      const stat = await fs.stat(fullPath);
      const durationSec = await probeDurationSec(fullPath, Math.max(6, Math.ceil(cleanText.split(" ").length / 2.5)));

      const totalChars = rawSegments.reduce((acc, seg) => acc + Math.max(1, seg.spokenText.length), 0);
      let c = 0;
      const weightedCaptions: TimedCaptionSegment[] = rawSegments.map((seg) => {
        const segDur = (Math.max(1, seg.spokenText.length) / totalChars) * durationSec;
        const item: TimedCaptionSegment = {
          lines: seg.lines,
          spokenText: seg.spokenText,
          startSec: Number(c.toFixed(3)),
          endSec: Number((c + segDur).toFixed(3)),
        };
        c += segDur;
        return item;
      });

      return {
        fullPath,
        bytes: stat.size,
        durationSec,
        engine: `windows-sapi-fallback (${edgeErr instanceof Error ? edgeErr.message : "offline"})`,
        cleanText,
        timedCaptions: weightedCaptions,
      };
    } finally {
      await fs.unlink(wavTemp).catch(() => {});
      await fs.unlink(psScriptPath).catch(() => {});
    }
  }
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

function drawArticulatedStickman(ctx: SKRSContext2D, rig: StickmanRig, t: number): void {
  const sc = rig.scale ?? 1;
  const facing = rig.facing ?? 1;
  const lean = rig.torsoLean ?? 0;

  ctx.save();
  ctx.translate(rig.x, rig.y);
  ctx.scale(sc * facing, sc);

  ctx.fillStyle = "rgba(15, 23, 42, 0.14)";
  ctx.beginPath();
  ctx.ellipse(0, 215, 95, 15, 0, 0, Math.PI * 2);
  ctx.fill();

  const hipX = 0;
  const hipY = 65;
  const torsoLen = 128;
  const shoulderX = Math.sin(lean) * torsoLen;
  const shoulderY = hipY - Math.cos(lean) * torsoLen;
  const headX = shoulderX + Math.sin(lean) * 62;
  const headY = shoulderY - Math.cos(lean) * 62;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const drawLimb = (
    ox: number,
    oy: number,
    upperLen: number,
    lowerLen: number,
    a1: number,
    a2: number,
    color: string,
    width: number
  ) => {
    const jx = ox + Math.sin(a1) * upperLen;
    const jy = oy + Math.cos(a1) * upperLen;
    const ex = jx + Math.sin(a1 + a2) * lowerLen;
    const ey = jy + Math.cos(a1 + a2) * lowerLen;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(jx, jy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  };

  drawLimb(shoulderX, shoulderY + 12, 68, 64, rig.leftShoulderAngle, rig.leftElbowAngle, "#334155", 11);
  drawLimb(hipX, hipY, 76, 74, rig.leftHipAngle, rig.leftKneeAngle, "#0f172a", 12);
  drawLimb(hipX, hipY, 76, 74, rig.rightHipAngle, rig.rightKneeAngle, "#1e293b", 12);

  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.lineTo(shoulderX, shoulderY);
  ctx.stroke();

  drawLimb(
    shoulderX,
    shoulderY + 12,
    70,
    66,
    rig.rightShoulderAngle,
    rig.rightElbowAngle,
    rig.accentRightArm ? "#4f46e5" : "#0f172a",
    12
  );

  ctx.save();
  ctx.translate(headX, headY);
  ctx.rotate(rig.headTilt ?? 0);

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(0, 0, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#0f172a";
  ctx.stroke();

  const blink = Math.abs(Math.sin(t * 1.35)) > 0.985 ? 2 : 6.5;
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.ellipse(-10, -8, 5.5, blink, 0, 0, Math.PI * 2);
  ctx.ellipse(20, -8, 5.5, blink, 0, 0, Math.PI * 2);
  ctx.fill();

  const expr = rig.expression ?? "happy";
  if (expr === "thinking") {
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(-20, -22);
    ctx.lineTo(-2, -18);
    ctx.moveTo(10, -24);
    ctx.lineTo(28, -28);
    ctx.stroke();
  }

  if (rig.talking) {
    const open = 3.5 + Math.abs(Math.sin(t * 13)) * 8.5;
    ctx.fillStyle = "#4f46e5";
    ctx.beginPath();
    ctx.ellipse(6, 17, 12, open, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (expr === "excited") {
    ctx.fillStyle = "#4f46e5";
    ctx.beginPath();
    ctx.arc(6, 14, 15, 0, Math.PI);
    ctx.fill();
  } else {
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(6, 12, 13, 0.15 * Math.PI, 0.85 * Math.PI);
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
  const reveal = Math.min(1, progress * 2.1);
  const m0 = (metrics[0] || "PHASE 1").slice(0, 22);
  const m1 = (metrics[1] || "PHASE 2").slice(0, 22);
  const m2 = (metrics[2] || "RESULT").slice(0, 22);
  const title = (propTitle || "BREAKDOWN").toUpperCase().slice(0, 28);

  ctx.save();
  ctx.translate(px, py);

  const cardW = 430;
  const cardH = 310;
  drawRoundedRect(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 24);
  ctx.fillStyle = darkTheme ? "rgba(15, 23, 42, 0.90)" : "#0f172a";
  ctx.fill();
  ctx.strokeStyle = propType === "blueprint_structure" ? "#22d3ee" : "#6366f1";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, 0, -cardH / 2 + 38);

  if (propType === "comparison_bars") {
    const items = [
      { label: m0, pct: 0.28, color: "#f43f5e", y: -42 },
      { label: m1, pct: 0.92, color: "#22c55e", y: 48 },
    ];
    items.forEach((it) => {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(it.label, -175, it.y - 12);

      drawRoundedRect(ctx, -175, it.y, 350, 24, 12);
      ctx.fillStyle = "#1e293b";
      ctx.fill();

      drawRoundedRect(ctx, -175, it.y, Math.max(24, 350 * it.pct * reveal), 24, 12);
      ctx.fillStyle = it.color;
      ctx.fill();
    });
  } else if (propType === "parallel_grid") {
    const cols = 4;
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const active = (r * cols + c) / (cols * rows) <= reveal;
        const pulse = active ? 0.55 + 0.45 * Math.sin(t * 9 + r * 2 + c) : 0.15;
        ctx.fillStyle = `rgba(99, 102, 241, ${pulse.toFixed(2)})`;
        drawRoundedRect(ctx, -166 + c * 86, -78 + r * 54, 72, 40, 10);
        ctx.fill();
      }
    }
    ctx.fillStyle = "#a5b4fc";
    ctx.font = "bold 20px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${m0} ? ${m1}`, 0, 118);
  } else if (propType === "flow_network") {
    const nodes = [
      { x: -130, y: -35, txt: m0 },
      { x: 0, y: 35, txt: m1 },
      { x: 130, y: -35, txt: m2 },
    ];
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y);
    if (reveal > 0.3) ctx.lineTo(nodes[1].x, nodes[1].y);
    if (reveal > 0.65) ctx.lineTo(nodes[2].x, nodes[2].y);
    ctx.stroke();

    nodes.forEach((n, idx) => {
      ctx.fillStyle = idx === 1 ? "#4f46e5" : "#1e293b";
      ctx.beginPath();
      ctx.arc(n.x, n.y, 44, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 3.5;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 15px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(n.txt.slice(0, 11), n.x, n.y + 5);
    });
  } else if (propType === "speed_gauge") {
    ctx.beginPath();
    ctx.arc(0, 35, 105, Math.PI, 0);
    ctx.lineWidth = 20;
    ctx.strokeStyle = "#1e293b";
    ctx.stroke();

    const angle = Math.PI + Math.PI * (0.82 * reveal + 0.06 * Math.sin(t * 6));
    ctx.beginPath();
    ctx.arc(0, 35, 105, Math.PI, angle);
    ctx.lineWidth = 20;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#22d3ee";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 30px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(m0, 0, 22);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 19px 'Segoe UI', Arial, sans-serif";
    ctx.fillText(m1, 0, 88);
  } else if (propType === "blueprint_structure") {
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 5;
    ctx.setLineDash([700 * reveal, 700]);
    ctx.beginPath();
    ctx.moveTo(-140, 85);
    ctx.lineTo(140, 85);
    ctx.moveTo(-105, 85);
    ctx.lineTo(-105, -20);
    ctx.lineTo(0, -92);
    ctx.lineTo(105, -20);
    ctx.lineTo(105, 85);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#e0f2fe";
    ctx.font = "bold 20px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`[ ${m0} ]`, 0, 122);
  } else if (propType === "magnifying_lens") {
    const bobX = Math.cos(t * 3) * 14;
    const bobY = Math.sin(t * 3) * 10;
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "bold 22px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(m0, 0, -25);
    ctx.fillStyle = "#38bdf8";
    ctx.fillText(m1, 0, 22);

    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(bobX - 15, bobY - 5, 68, 0, Math.PI * 2);
    ctx.moveTo(bobX + 34, bobY + 42);
    ctx.lineTo(bobX + 86, bobY + 94);
    ctx.stroke();
  } else if (propType === "trophy_badge") {
    const pulse = 1 + Math.sin(t * 6) * 0.05;
    ctx.scale(pulse, pulse);
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(0, -15, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 44px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("?", 0, 2);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 22px 'Segoe UI', Arial, sans-serif";
    ctx.fillText(m0, 0, 86);
    ctx.fillStyle = "#86efac";
    ctx.font = "bold 18px 'Segoe UI', Arial, sans-serif";
    ctx.fillText(m1, 0, 118);
  } else {
    const pts = [
      { x: -145, y: 75, lbl: m0 },
      { x: 0, y: 15, lbl: m1 },
      { x: 145, y: -65, lbl: m2 },
    ];
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (reveal > 0.25) ctx.lineTo(pts[1].x, pts[1].y);
    if (reveal > 0.65) ctx.lineTo(pts[2].x, pts[2].y);
    ctx.stroke();

    pts.forEach((pt, idx) => {
      if (reveal >= idx * 0.3) {
        ctx.fillStyle = idx === 2 ? "#22c55e" : "#818cf8";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "bold 16px 'Segoe UI', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(pt.lbl.slice(0, 14), pt.x, pt.y + 30);
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
  sceneProgress: number
): void {
  const action = beat.action || "presenting_board";
  const pos = beat.position || (sceneIdx % 2 === 0 ? "left" : "right");
  const propType = beat.propType || "growth_chart";
  const propTitle = beat.propTitle || beat.beatSummary || "KEY CONCEPT";
  const propMetrics = beat.propMetrics && beat.propMetrics.length > 0 ? beat.propMetrics : ["BEFORE", "AFTER"];

  const cx = w * 0.5;
  const cy = h * 0.48;

  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, "#f8fafc");
  bgGrad.addColorStop(1, "#e2e8f0");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(15, 23, 42, 0.14)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(64, cy + 215);
  ctx.lineTo(w - 64, cy + 215);
  ctx.stroke();

  let charX = cx - 235;
  let charY = cy;
  let facing: 1 | -1 = 1;
  let propX = cx + 175;
  let propY = cy - 25;

  if (pos === "right") {
    charX = cx + 235;
    facing = -1;
    propX = cx - 175;
  } else if (pos === "center" || action === "celebrating") {
    charX = cx;
    propX = cx;
    propY = cy - 220;
  } else if (pos === "traverse" || action === "walking_across") {
    charX = w * 0.22 + sceneProgress * (w * 0.56);
    propX = cx;
    propY = cy - 225;
  }

  drawDynamicProp(ctx, propType, propTitle, propMetrics, propX, propY, t, sceneProgress, false);

  const stride = t * 8.5;
  let rig: StickmanRig = {
    x: charX,
    y: charY + Math.sin(t * 4) * 5,
    scale: pos === "center" ? 0.85 : 0.92,
    facing,
    torsoLean: 0.08,
    leftShoulderAngle: 0.35,
    leftElbowAngle: -0.35,
    rightShoulderAngle: -1.35 + Math.sin(t * 6.5) * 0.22,
    rightElbowAngle: -0.25,
    leftHipAngle: 0.2,
    leftKneeAngle: 0,
    rightHipAngle: -0.2,
    rightKneeAngle: 0,
    expression: "happy",
    talking: true,
    accentRightArm: true,
  };

  if (action === "thinking") {
    rig = {
      ...rig,
      torsoLean: 0.12,
      headTilt: -0.14 + Math.sin(t * 2.5) * 0.06,
      rightShoulderAngle: -2.25 + Math.sin(t * 5) * 0.1,
      rightElbowAngle: -1.35,
      expression: "thinking",
    };
  } else if (action === "walking_across") {
    rig = {
      ...rig,
      y: charY - Math.abs(Math.sin(stride)) * 13,
      torsoLean: 0.16,
      leftShoulderAngle: Math.sin(stride) * 0.65,
      leftElbowAngle: -0.45,
      rightShoulderAngle: -Math.sin(stride) * 0.65,
      rightElbowAngle: -0.55,
      leftHipAngle: -Math.sin(stride) * 0.58,
      leftKneeAngle: Math.max(0, Math.sin(stride) * 0.75),
      rightHipAngle: Math.sin(stride) * 0.58,
      rightKneeAngle: Math.max(0, -Math.sin(stride) * 0.75),
    };
  } else if (action === "juggling_tasks") {
    const jug = Math.sin(t * 9) * 0.55;
    rig = {
      ...rig,
      leftShoulderAngle: -2.1 + jug,
      leftElbowAngle: -0.5,
      rightShoulderAngle: -2.1 - jug,
      rightElbowAngle: 0.5,
      expression: "excited",
    };
  } else if (action === "examining_lens") {
    rig = {
      ...rig,
      torsoLean: 0.22,
      headTilt: 0.12,
      rightShoulderAngle: -1.65,
      rightElbowAngle: -0.55,
      expression: "focused",
    };
  } else if (action === "celebrating") {
    const jump = Math.abs(Math.sin(t * 4.8));
    rig = {
      ...rig,
      y: charY + 45 - jump * 48,
      leftShoulderAngle: -2.45 - jump * 0.2,
      rightShoulderAngle: -2.45 - jump * 0.2,
      leftHipAngle: 0.35 + jump * 0.2,
      leftKneeAngle: -0.4 * jump,
      rightHipAngle: -0.35 - jump * 0.2,
      rightKneeAngle: 0.4 * jump,
      expression: "excited",
    };
  } else if (action === "directing_swarm") {
    [-1, 1].forEach((dir, idx) => {
      const lift = Math.sin(t * 7 + idx) * 0.35;
      drawArticulatedStickman(
        ctx,
        {
          x: propX + dir * 135,
          y: propY + 215,
          scale: 0.42,
          facing,
          leftShoulderAngle: -2.3 + lift,
          leftElbowAngle: -0.3,
          rightShoulderAngle: -2.3 + lift,
          rightElbowAngle: 0.3,
          leftHipAngle: 0.22,
          leftKneeAngle: 0,
          rightHipAngle: -0.22,
          rightKneeAngle: 0,
          expression: "happy",
          talking: false,
          accentRightArm: true,
        },
        t + idx
      );
    });
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
  ctx.fillStyle = "#060b19";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(56, 189, 248, 0.10)";
  ctx.lineWidth = 1.5;
  for (let x = 0; x <= w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

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
  const style: VideoStyleId = params.videoStyle || "stock_ken_burns";

  const audioDuration = await probeDurationSec(audioPath, 15);
  const safeDuration = Math.max(5, audioDuration + 0.5);
  const totalFrames = Math.ceil(safeDuration * fps);

  const cleanTitle = sanitizeNarrationText(params.title) || params.channelName;
  const cleanScript = sanitizeNarrationText(params.script || params.hook);

  // Use exact audio-measured caption timestamps so captions stay 100% synced with speech
  const syncedCaptions: TimedCaptionSegment[] =
    params.timedCaptions && params.timedCaptions.length > 0
      ? params.timedCaptions
      : (() => {
          const fallback = splitScriptIntoCaptionSegments(
            cleanScript,
            isLandscape ? 46 : 27,
            3
          );
          const totalChars = fallback.reduce((a, b) => a + Math.max(1, b.spokenText.length), 0);
          let c = 0;
          return fallback.map((seg) => {
            const d = (Math.max(1, seg.spokenText.length) / totalChars) * audioDuration;
            const out: TimedCaptionSegment = {
              lines: seg.lines,
              spokenText: seg.spokenText,
              startSec: c,
              endSec: c + d,
            };
            c += d;
            return out;
          });
        })();

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
      "-i", audioPath,
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

  const isLightTheme = style === "stickman_explainer";
  const accentHex =
    style === "minimal_line_art" || style === "tech_hud_blueprint" ? "#22d3ee" : "#6366f1";

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const sceneIdx = Math.min(sceneCount - 1, Math.floor(t / sceneDur));
    const sceneProgress = (t - sceneIdx * sceneDur) / sceneDur;
    const activeBeat = aiBeats[sceneIdx]!;

    if (style === "stickman_explainer") {
      renderDynamicStickmanScene(ctx, width, height, t, activeBeat, sceneIdx, sceneProgress);
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
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, "#09090b");
      grad.addColorStop(0.5, style === "tech_hud_blueprint" ? "#082f49" : "#1e1b4b");
      grad.addColorStop(1, "#09090b");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

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

    const headerH = isLandscape ? 155 : 235;
    drawRoundedRect(ctx, 44, 44, width - 88, headerH, 24);
    ctx.fillStyle = isLightTheme ? "rgba(15, 23, 42, 0.92)" : "rgba(9, 9, 11, 0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
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

    // Exact Audio-Synced Caption Lookup
    const activeCaption =
      syncedCaptions.find((seg) => t >= seg.startSec && t < seg.endSec) ??
      syncedCaptions[syncedCaptions.length - 1]!;
    const pageLines = activeCaption?.lines ?? [];
    const capFadeIn = Math.min(1, Math.max(0, (t - (activeCaption?.startSec ?? 0)) / 0.14));

    const capBoxY = style === "kinetic_typography"
      ? height * 0.40
      : isLandscape ? 720 : 1310;
    const capBoxH = isLandscape ? 230 : 340;

    ctx.save();
    ctx.globalAlpha = 0.4 + 0.6 * capFadeIn;
    drawRoundedRect(ctx, 48, capBoxY, width - 96, capBoxH, 28);
    ctx.fillStyle = isLightTheme ? "rgba(15, 23, 42, 0.94)" : "rgba(9, 9, 11, 0.84)";
    ctx.fill();
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#f8fafc";
    const capFontSize = style === "kinetic_typography" ? 52 : isLandscape ? 38 : 46;
    ctx.font = `bold ${capFontSize}px 'Segoe UI', Arial, sans-serif`;
    ctx.textAlign = "center";
    const lineHeight = capFontSize + 18;
    const startTextY = capBoxY + (capBoxH - pageLines.length * lineHeight) / 2 + capFontSize * 0.85;

    pageLines.forEach((line, lIdx) => {
      ctx.fillText(line, width / 2, startTextY + lIdx * lineHeight);
    });
    ctx.restore();

    const barY = height - 92;
    const barW = width - 96;
    drawRoundedRect(ctx, 48, barY, barW, 12, 6);
    ctx.fillStyle = "rgba(148, 163, 184, 0.28)";
    ctx.fill();

    const fillW = Math.max(12, barW * Math.min(1, t / safeDuration));
    drawRoundedRect(ctx, 48, barY, fillW, 12, 6);
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
