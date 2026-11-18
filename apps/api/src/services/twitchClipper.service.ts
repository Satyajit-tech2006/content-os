import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { prisma } from "@contentos/database";
import { logger } from "../lib/logger.js";

const workerRequire = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../worker/package.json"));
const ffmpegPath = (workerRequire("ffmpeg-static") as string) || "ffmpeg";
const STORAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.contentos-storage");

const HYPE_TOKENS = [
  "w", "ww", "www", "wwww", "clip", "clip it", "clip that", "omg", "no way",
  "bro", "what", "wtf", "insane", "crazy", "gg", "pog", "poggers", "sheesh",
  "gta", "gta6", "gta 6", "lucia", "jason", "vice city", "leonida", "5 stars", "wasted"
];

export interface ChatSample {
  id: string;
  user: string;
  text: string;
  score: number;
  ts: number;
}

export interface CapturedClipInfo {
  assetId: string;
  title: string;
  channel: string;
  spikeMultiplier: number;
  triggeredAt: string;
  mediaUrl: string;
  topChat: string[];
}

export interface WatcherState {
  workspaceId: string;
  projectId: string;
  channel: string;
  status: "STARTING" | "LIVE_WATCHING" | "CHANNEL_OFFLINE_CHAT_ONLY" | "STOPPED" | "ERROR";
  startedAt: string;
  preRollSec: number;
  postRollSec: number;
  sensitivity: number;
  messagesPerSec: number;
  baselinePerSec: number;
  hypeMultiplier: number;
  cooldownRemainingSec: number;
  totalMessagesSeen: number;
  clipsCaptured: CapturedClipInfo[];
  recentChat: ChatSample[];
  lastError?: string;
}

interface InternalWatcher {
  state: WatcherState;
  ws: WebSocket | null;
  hlsProc: ReturnType<typeof spawn> | null;
  hlsPollTimer: NodeJS.Timeout | null;
  seenSegments: Set<string>;
  isAdBreak: boolean;
  metricsTimer: NodeJS.Timeout | null;
  bufferDir: string;
  msgTimestamps: { ts: number; weight: number }[];
  lastClipAt: number;
  streamConnectedAt: number;
  clippingInProgress: boolean;
  stopped: boolean;
}

const activeWatchers = new Map<string, InternalWatcher>();

function normalizeChannel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, "")
    .replace(/[^a-z0-9_]/g, "");
}

function scoreChatMessage(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  const lower = clean.toLowerCase();
  let weight = 1.0;

  for (const tok of HYPE_TOKENS) {
    if (lower === tok || lower.includes(tok)) {
      weight += 0.95;
    }
  }
  const letters = clean.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    weight += 0.85;
  }
  if (/!{2,}|\?{2,}/.test(clean)) {
    weight += 0.4;
  }
  return Math.min(4.5, weight);
}

async function resolveTwitchHlsUrl(channel: string): Promise<string | null> {
  try {
    const gqlRes = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: {
        "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
        "Content-Type": "application/json",
        ...(process.env.TWITCH_AUTH_TOKEN
          ? { Authorization: `OAuth ${process.env.TWITCH_AUTH_TOKEN.trim()}` }
          : {}),
      },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken_Template",
        query:
          'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } }',
        variables: {
          isLive: true,
          login: channel,
          playerType: "site",
        },
      }),
    });

    if (!gqlRes.ok) return null;
    const gqlJson = (await gqlRes.json()) as {
      data?: { streamPlaybackAccessToken?: { value: string; signature: string } };
    };
    const token = gqlJson?.data?.streamPlaybackAccessToken;
    if (!token?.value || !token?.signature) return null;

    const usherUrl = new URL(`https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8`);
    usherUrl.searchParams.set("allow_source", "true");
    usherUrl.searchParams.set("allow_audio_only", "false");
    usherUrl.searchParams.set("fast_bread", "true");
    usherUrl.searchParams.set("p", String(Math.floor(Math.random() * 999999)));
    usherUrl.searchParams.set("sig", token.signature);
    usherUrl.searchParams.set("token", token.value);

    const masterRes = await fetch(usherUrl.toString());
    if (!masterRes.ok) return null;
    const masterPlaylist = await masterRes.text();
    const variantLine = masterPlaylist
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("http"));
    return variantLine || null;
  } catch {
    return null;
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
    proc.on("error", reject);
  });
}

async function createClipFromBufferOrFallback(
  watcher: InternalWatcher,
  spikeMultiplier: number,
  reasonLabel: string
): Promise<void> {
  if (watcher.clippingInProgress || watcher.stopped) return;
  watcher.clippingInProgress = true;
  watcher.lastClipAt = Date.now();

  try {
    const { workspaceId, projectId, channel, preRollSec, postRollSec } = watcher.state;
    const topChat = watcher.state.recentChat
      .slice(-8)
      .map((c) => `${c.user}: ${c.text}`);

    const existingSegments = fs.existsSync(watcher.bufferDir)
      ? fs.readdirSync(watcher.bufferDir).filter((f) => f.endsWith(".ts")).sort()
      : [];

    if (existingSegments.length > 0) {
      await new Promise((r) => setTimeout(r, Math.min(12, Math.max(3, postRollSec)) * 1000));
    }

    const assetDir = path.join(STORAGE_ROOT, "live-clips", workspaceId);
    await fsp.mkdir(assetDir, { recursive: true });
    const stamp = Date.now();
    const existingCount = await prisma.contentAsset.count({
      where: {
        workspaceId,
        fileName: { startsWith: `${channel}_clip` },
      },
    });
    const clipNumber = existingCount + 1;
    const clipSlug = `${channel}_clip${clipNumber}`;
    const outFileName = `${clipSlug}.mp4`;
    const outPath = path.join(assetDir, outFileName);
    const storageKey = `live-clips/${workspaceId}/${outFileName}`;

    const allSegments = fs.existsSync(watcher.bufferDir)
      ? fs
          .readdirSync(watcher.bufferDir)
          .filter((f) => f.endsWith(".ts"))
          .map((f) => ({
            name: f,
            full: path.join(watcher.bufferDir, f),
            mtime: fs.statSync(path.join(watcher.bufferDir, f)).mtimeMs,
          }))
          .sort((a, b) => a.mtime - b.mtime)
      : [];

    const neededCount = Math.max(4, Math.ceil((preRollSec + postRollSec) / 2));
    const chosenSegments = allSegments.slice(-neededCount);

    if (chosenSegments.length >= 2) {
      const concatListPath = path.join(watcher.bufferDir, `concat-${stamp}.txt`);
      const rawJoinedPath = path.join(watcher.bufferDir, `raw-${stamp}.mp4`);
      const listContent = chosenSegments
        .map((s) => `file '${s.full.replace(/\\/g, "/")}'`)
        .join("\n");
      await fsp.writeFile(concatListPath, listContent, "utf8");

      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c", "copy",
        rawJoinedPath,
      ]);

      await runFfmpeg([
        "-y",
        "-i", rawJoinedPath,
        "-filter_complex",
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:6[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]",
        "-map", "[v]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        outPath,
      ]);
    } else {
      await runFfmpeg([
        "-y",
        "-f", "lavfi",
        "-i", "color=c=#090d16:s=1080x1920:r=30:d=12",
        "-f", "lavfi",
        "-i", "sine=frequency=220:sample_rate=44100:duration=12",
        "-vf",
        "drawbox=x=60:y=620:w=960:h=540:color=#1e293b@0.9:t=fill,drawbox=x=60:y=620:w=960:h=8:color=#f97316:t=fill",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outPath,
      ]);
    }

    const stat = await fsp.stat(outPath);
    const title = `${clipSlug} (${spikeMultiplier.toFixed(1)}x Hype)`;
    const hook = `Chat erupted (${spikeMultiplier.toFixed(1)}x baseline) during ${channel}'s live stream! (${reasonLabel})`;
    const voiceoverScript = topChat.slice(0, 4).join(" | ") || hook;

    const asset = await prisma.contentAsset.create({
      data: {
        workspaceId,
        projectId,
        type: "RENDERED_VIDEO",
        fileName: outFileName,
        mimeType: "video/mp4",
        fileSize: BigInt(stat.size),
        storageKey,
        status: "READY",
        approvalStatus: "PENDING_APPROVAL",
        currentRevisionNum: 1,
        metadata: {
          source: "TWITCH_LIVE_HYPE_AGENT",
          channel,
          spikeMultiplier,
          preRollSec,
          postRollSec,
          topChat,
          script: {
            title,
            hook,
            voiceoverScript,
            hashtags: ["#GTAVI", "#GTA6", "#TwitchClips", "#GamingNews", "#CheckpointDaily"],
          },
        },
      },
    });

    await prisma.contentRevision.create({
      data: {
        workspaceId,
        projectId,
        assetId: asset.id,
        revisionNumber: 1,
        source: "AI_GENERATED",
        title,
        hook,
        voiceoverScript,
        description: hook,
        hashtags: ["#GTAVI", "#GTA6", "#TwitchClips", "#GamingNews", "#CheckpointDaily"],
        scriptPayload: {
          channel,
          spikeMultiplier,
          topChat,
        },
      },
    });

    watcher.state.clipsCaptured.unshift({
      assetId: asset.id,
      title,
      channel,
      spikeMultiplier,
      triggeredAt: new Date().toISOString(),
      mediaUrl: `/media/${storageKey}`,
      topChat,
    });
    logger.info({ workspaceId, channel, assetId: asset.id, spikeMultiplier }, "Captured live Twitch hype clip");
  } catch (err) {
    logger.error({ err }, "Failed to finalize live Twitch hype clip");
    watcher.state.lastError = err instanceof Error ? err.message : "Clip render failed";
  } finally {
    watcher.clippingInProgress = false;
  }
}

export async function startTwitchLiveWatcher(params: {
  workspaceId: string;
  projectId: string;
  channel: string;
  preRollSec?: number;
  postRollSec?: number;
  sensitivity?: number;
}): Promise<WatcherState> {
  await stopTwitchLiveWatcher(params.workspaceId);

  const channel = normalizeChannel(params.channel);
  if (!channel) {
    throw new Error("Please enter a valid Twitch channel name or URL.");
  }

  const bufferDir = path.join(STORAGE_ROOT, ".live-buffer", `${params.workspaceId}-${channel}`);
  await fsp.rm(bufferDir, { recursive: true, force: true });
  await fsp.mkdir(bufferDir, { recursive: true });

  const state: WatcherState = {
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    channel,
    status: "STARTING",
    startedAt: new Date().toISOString(),
    preRollSec: Math.min(30, Math.max(5, params.preRollSec ?? 15)),
    postRollSec: Math.min(25, Math.max(5, params.postRollSec ?? 12)),
    sensitivity: Math.min(5.0, Math.max(1.8, params.sensitivity ?? 2.8)),
    messagesPerSec: 0,
    baselinePerSec: 0.4,
    hypeMultiplier: 1.0,
    cooldownRemainingSec: 0,
    totalMessagesSeen: 0,
    clipsCaptured: [],
    recentChat: [],
  };

  const watcher: InternalWatcher = {
    state,
    ws: null,
    hlsProc: null,
    hlsPollTimer: null,
    seenSegments: new Set<string>(),
    isAdBreak: false,
    metricsTimer: null,
    bufferDir,
    msgTimestamps: [],
    lastClipAt: 0,
    streamConnectedAt: Date.now(),
    clippingInProgress: false,
    stopped: false,
  };

  activeWatchers.set(params.workspaceId, watcher);

  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  watcher.ws = ws;

  ws.addEventListener("open", () => {
    const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("PASS SCHMOOPIIE");
    ws.send(`NICK ${nick}`);
    ws.send(`JOIN #${channel}`);
  });

  ws.addEventListener("message", (event) => {
    const raw = String(event.data || "");
    for (const line of raw.split("\r\n")) {
      if (!line) continue;
      if (line.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        continue;
      }
      const privIdx = line.indexOf("PRIVMSG #");
      if (privIdx !== -1) {
        const msgStart = line.indexOf(" :", privIdx);
        const text = msgStart !== -1 ? line.slice(msgStart + 2).trim() : "";
        const userMatch = line.match(/display-name=([^;\s]+)/) || line.match(/:([^!]+)!/);
        const user = userMatch?.[1] || "viewer";
        if (text) {
          ingestChatMessage(watcher, user, text);
        }
      }
    }
  });

  ws.addEventListener("error", () => {
    watcher.state.lastError = "Twitch IRC connection interrupted";
  });

  const hlsUrl = await resolveTwitchHlsUrl(channel);
  if (hlsUrl && !watcher.stopped) {
    watcher.state.status = "LIVE_WATCHING";
    watcher.streamConnectedAt = Date.now();
    let segSeq = 0;
    let adEndsAt = 0;
    let consecutiveFailures = 0;

    const pollPlaylist = async () => {
      if (watcher.stopped) return;
      try {
        const res = await fetch(hlsUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 8) watcher.state.status = "CHANNEL_OFFLINE_CHAT_ONLY";
          return;
        }
        consecutiveFailures = 0;
        const m3u8 = await res.text();
        const lines = m3u8.split("\n").map((l) => l.trim()).filter(Boolean);

        let tagAdActive = false;
        const cleanUrls: string[] = [];

        for (const line of lines) {
          if (line.startsWith("#EXT-X-DATERANGE") || line.startsWith("#EXT-X-SCTE35")) {
            if (/stitched-ad|twitch-ad|AMAZON|commercial/i.test(line)) {
              tagAdActive = true;
              const durMatch = line.match(/DURATION=([0-9.]+)/i);
              const durSec = durMatch ? Number(durMatch[1]) : 30;
              adEndsAt = Math.max(adEndsAt, Date.now() + (durSec + 4) * 1000);
            }
          }
          if (line.startsWith("http")) {
            const urlLooksLikeAd = /stitched-ad|cloudfront\.net\/ads|adserver|amazon-adsystem/i.test(line);
            const inAd = tagAdActive || urlLooksLikeAd || Date.now() < adEndsAt;
            if (!inAd && !watcher.seenSegments.has(line)) {
              cleanUrls.push(line);
            }
            watcher.seenSegments.add(line);
          }
        }

        watcher.isAdBreak = tagAdActive || Date.now() < adEndsAt;
        if (watcher.seenSegments.size > 500) {
          watcher.seenSegments = new Set(Array.from(watcher.seenSegments).slice(-250));
        }

        for (const segUrl of cleanUrls) {
          if (watcher.stopped) break;
          const segRes = await fetch(segUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (!segRes.ok) continue;
          const buf = Buffer.from(await segRes.arrayBuffer());
          // Static "Commercial break in progress" 2s slates are typically 90-240 KB; live 1080p gameplay is > 300 KB
          if (buf.length < 260 * 1024) {
            watcher.isAdBreak = true;
            continue;
          }
          const idx = String(segSeq++ % 45).padStart(5, "0");
          await fsp.writeFile(path.join(bufferDir, `seg_${idx}.ts`), buf);
        }
      } catch {
        consecutiveFailures += 1;
      }
    };

    await pollPlaylist();
    watcher.hlsPollTimer = setInterval(() => {
      void pollPlaylist();
    }, 1800);
  } else {
    watcher.state.status = "CHANNEL_OFFLINE_CHAT_ONLY";
  }

  watcher.metricsTimer = setInterval(() => {
    if (watcher.stopped) return;
    const now = Date.now();
    watcher.msgTimestamps = watcher.msgTimestamps.filter((m) => now - m.ts <= 60_000);

    const last5s = watcher.msgTimestamps.filter((m) => now - m.ts <= 5_000);
    const prev55s = watcher.msgTimestamps.filter((m) => now - m.ts > 5_000);

    const currentWeightedRate = last5s.reduce((acc, m) => acc + m.weight, 0) / 5;
    const baselineWeightedRate = Math.max(0.45, prev55s.reduce((acc, m) => acc + m.weight, 0) / 55);
    const multiplier = currentWeightedRate / baselineWeightedRate;

    watcher.state.messagesPerSec = Number((last5s.length / 5).toFixed(2));
    watcher.state.baselinePerSec = Number(baselineWeightedRate.toFixed(2));
    watcher.state.hypeMultiplier = Number(multiplier.toFixed(2));

    const elapsedSinceClip = (now - watcher.lastClipAt) / 1000;
    watcher.state.cooldownRemainingSec = Math.max(0, Math.ceil(45 - elapsedSinceClip));

    if (
      last5s.length >= 6 &&
      multiplier >= watcher.state.sensitivity &&
      now - watcher.streamConnectedAt >= 25_000 &&
      elapsedSinceClip >= 45 &&
      !watcher.isAdBreak &&
      !watcher.clippingInProgress
    ) {
      void createClipFromBufferOrFallback(
        watcher,
        multiplier,
        `${last5s.length} hype msgs in 5s (${multiplier.toFixed(1)}x baseline)`
      );
    }
  }, 1000);

  return watcher.state;
}

function ingestChatMessage(watcher: InternalWatcher, user: string, text: string): void {
  const now = Date.now();
  const score = scoreChatMessage(text);
  watcher.msgTimestamps.push({ ts: now, weight: score });
  watcher.state.totalMessagesSeen += 1;
  watcher.state.recentChat.push({
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    user,
    text,
    score: Number(score.toFixed(2)),
    ts: now,
  });
  if (watcher.state.recentChat.length > 25) {
    watcher.state.recentChat.shift();
  }
}

export async function simulateChatSpike(workspaceId: string): Promise<WatcherState> {
  const watcher = activeWatchers.get(workspaceId);
  if (!watcher) {
    throw new Error("Start the Twitch Live Watcher on a channel first.");
  }
  const sampleBurst = [
    ["ViceCityFan", "NO WAYYYYY LUCIA JUST DID THAT"],
    ["LeonidaRider", "WWWWWWWWWWWW"],
    ["GamerX99", "CLIP THAT RIGHT NOW OMG"],
    ["DriftKing", "5 STARS ALREADY?! WHAT A CHASE"],
    ["CheckpointViewer", "BROOOOOO INSANE PHYSICS"],
    ["NightOwl", "W CLIP W CLIP W CLIP"],
    ["MiamiVibes", "OMG LOOK AT THE GRAPHICS"],
    ["SpeedRunner", "CLIP IT!!"],
  ];
  for (const [u, msg] of sampleBurst) {
    ingestChatMessage(watcher, u!, msg!);
  }
  await createClipFromBufferOrFallback(watcher, 4.6, "Simulated Viral Chat Spike");
  return watcher.state;
}

export function getTwitchWatcherStatus(workspaceId: string): WatcherState | null {
  return activeWatchers.get(workspaceId)?.state ?? null;
}

export async function stopTwitchLiveWatcher(workspaceId: string): Promise<void> {
  const watcher = activeWatchers.get(workspaceId);
  if (!watcher) return;
  watcher.stopped = true;
  watcher.state.status = "STOPPED";
  if (watcher.metricsTimer) clearInterval(watcher.metricsTimer);
  if (watcher.hlsPollTimer) clearInterval(watcher.hlsPollTimer);
  try {
    watcher.ws?.close();
  } catch {}
  try {
    watcher.hlsProc?.kill("SIGTERM");
  } catch {}
  activeWatchers.delete(workspaceId);
}
