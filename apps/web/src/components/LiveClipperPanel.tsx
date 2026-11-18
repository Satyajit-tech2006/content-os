"use client";

import React, { useEffect, useState } from "react";
import { Radio, Scissors, Sparkles, Square, Zap } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface ChatSample {
  id: string;
  user: string;
  text: string;
  score: number;
  ts: number;
}

interface CapturedClipInfo {
  assetId: string;
  title: string;
  channel: string;
  spikeMultiplier: number;
  triggeredAt: string;
  mediaUrl: string;
  topChat: string[];
}

interface WatcherState {
  workspaceId: string;
  projectId: string;
  channel: string;
  status: "STARTING" | "LIVE_WATCHING" | "CHANNEL_OFFLINE_CHAT_ONLY" | "STOPPED" | "ERROR";
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

export function LiveClipperPanel({
  workspaceId,
  projectId,
  projects,
}: {
  workspaceId: string;
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
}) {
  const [selectedTargetProjectId, setSelectedTargetProjectId] = useState(
    projectId || projects?.[0]?.id || ""
  );
  const [channel, setChannel] = useState("shroud");
  const [preRollSec, setPreRollSec] = useState(15);
  const [postRollSec, setPostRollSec] = useState(12);
  const [sensitivity, setSensitivity] = useState(2.8);
  const [watcher, setWatcher] = useState<WatcherState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId) setSelectedTargetProjectId(projectId);
    else if (!selectedTargetProjectId && projects && projects.length > 0) {
      setSelectedTargetProjectId(projects[0].id);
    }
  }, [projectId, projects, selectedTargetProjectId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await apiFetch<{ watcher: WatcherState | null }>(
          `/workspaces/${workspaceId}/live-clipper/status`
        );
        if (active) setWatcher(res.watcher);
      } catch {}
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [workspaceId]);

  const isRunning =
    watcher &&
    (watcher.status === "STARTING" ||
      watcher.status === "LIVE_WATCHING" ||
      watcher.status === "CHANNEL_OFFLINE_CHAT_ONLY");

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ watcher: WatcherState }>(
        `/workspaces/${workspaceId}/live-clipper/start`,
        {
          method: "POST",
          body: JSON.stringify({
            channel,
            projectId: projectId || selectedTargetProjectId,
            preRollSec,
            postRollSec,
            sensitivity,
          }),
        }
      );
      setWatcher(res.watcher);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Twitch watcher");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      await apiFetch(`/workspaces/${workspaceId}/live-clipper/stop`, { method: "POST" });
      setWatcher(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSimulate() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ watcher: WatcherState }>(
        `/workspaces/${workspaceId}/live-clipper/simulate`,
        { method: "POST" }
      );
      setWatcher(res.watcher);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-orange-400" />
          <h3 className="text-sm font-semibold text-zinc-100">
            Twitch Autonomous Hype-Clipper Agent
          </h3>
        </div>
        {isRunning && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
            <Radio className="h-3 w-3 animate-pulse" />
            {watcher?.status === "LIVE_WATCHING" ? "LIVE STREAM + CHAT" : "CHAT RADAR ACTIVE"}
          </span>
        )}
      </div>

      <p className="text-xs text-zinc-400">
        Monitors live Twitch chat velocity &amp; hype reactions in real time, slices{" "}
        <span className="text-zinc-200 font-medium">-{preRollSec}s pre-roll</span> to{" "}
        <span className="text-zinc-200 font-medium">+{postRollSec}s post-roll</span>, and drops
        9:16 vertical Shorts straight into your Content Library.
      </p>

      {!projectId && projects && projects.length > 0 && (
        <div>
          <label className="block text-[11px] text-zinc-400 mb-1">
            Destination Project (Content Library)
          </label>
          <select
            value={selectedTargetProjectId}
            onChange={(e) => setSelectedTargetProjectId(e.target.value)}
            disabled={Boolean(isRunning)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:border-orange-500 focus:outline-none disabled:opacity-50"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
        <div className="sm:col-span-2">
          <label className="block text-[11px] text-zinc-400 mb-1">Twitch Channel / URL</label>
          <input
            type="text"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="e.g. shroud, kai_cenat, gta"
            disabled={Boolean(isRunning)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:border-orange-500 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-[11px] text-zinc-400 mb-1">Pre / Post Roll (s)</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={5}
              max={30}
              value={preRollSec}
              onChange={(e) => setPreRollSec(Number(e.target.value))}
              disabled={Boolean(isRunning)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
            />
            <input
              type="number"
              min={5}
              max={25}
              value={postRollSec}
              onChange={(e) => setPostRollSec(Number(e.target.value))}
              disabled={Boolean(isRunning)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
            />
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-zinc-400 mb-1">Spike Trigger (x)</label>
          <input
            type="number"
            step="0.2"
            min={1.8}
            max={5.0}
            value={sensitivity}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            disabled={Boolean(isRunning)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!isRunning ? (
          <button
            type="button"
            disabled={busy || !channel.trim() || !(projectId || selectedTargetProjectId)}
            onClick={handleStart}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            <Zap className="h-3.5 w-3.5" />
            {busy ? "Connecting..." : "Start Live Twitch Watcher"}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={handleStop}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" />
              Stop Watcher
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleSimulate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Simulate Chat Spike
            </button>
          </>
        )}
      </div>

      {watcher && (
        <div className="space-y-3 pt-2 border-t border-zinc-800/80">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-zinc-950/80 border border-zinc-800 p-2">
              <div className="text-[10px] text-zinc-500 uppercase">Chat Rate</div>
              <div className="text-sm font-bold text-zinc-100">{watcher.messagesPerSec}/s</div>
            </div>
            <div className="rounded-lg bg-zinc-950/80 border border-zinc-800 p-2">
              <div className="text-[10px] text-zinc-500 uppercase">Hype Multiplier</div>
              <div className="text-sm font-bold text-orange-400">{watcher.hypeMultiplier}x</div>
            </div>
            <div className="rounded-lg bg-zinc-950/80 border border-zinc-800 p-2">
              <div className="text-[10px] text-zinc-500 uppercase">Msgs Scanned</div>
              <div className="text-sm font-bold text-zinc-100">{watcher.totalMessagesSeen}</div>
            </div>
            <div className="rounded-lg bg-zinc-950/80 border border-zinc-800 p-2">
              <div className="text-[10px] text-zinc-500 uppercase">Clips Cut</div>
              <div className="text-sm font-bold text-emerald-400">
                {watcher.clipsCaptured.length}
              </div>
            </div>
          </div>

          {watcher.recentChat.length > 0 && (
            <div className="rounded-lg bg-zinc-950/90 border border-zinc-800 p-2.5 max-h-28 overflow-y-auto space-y-1">
              {watcher.recentChat.slice(-6).map((msg) => (
                <div key={msg.id} className="text-[11px] flex items-center justify-between gap-2">
                  <span className="truncate text-zinc-300">
                    <strong className="text-indigo-400">{msg.user}:</strong> {msg.text}
                  </span>
                  <span className="text-[10px] text-zinc-500 shrink-0">+{msg.score}</span>
                </div>
              ))}
            </div>
          )}

          {watcher.clipsCaptured.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-emerald-400">
                Auto-Captured Clips (Saved to Content Library)
              </div>
              {watcher.clipsCaptured.map((clip) => (
                <div
                  key={clip.assetId}
                  className="flex items-center justify-between rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs"
                >
                  <span className="truncate text-zinc-100 font-medium">{clip.title}</span>
                  <span className="text-[11px] text-emerald-300 shrink-0">
                    {clip.spikeMultiplier.toFixed(1)}x Spike
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
