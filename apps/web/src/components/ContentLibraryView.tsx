"use client";
import React, { useEffect, useState, useCallback } from "react";
import { CheckCircle2, XCircle, FileText, Video, Save, Loader2, Download } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

export interface ContentAssetDTO {
  id: string;
  projectId: string;
  executionId: string | null;
  type: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  status: string;
  metadata: {
    title?: string;
    approvalStatus?: string;
    durationSec?: number;
    resolution?: string;
    script?: {
      title?: string;
      hook?: string;
      voiceoverScript?: string;
      caption?: string;
      cta?: string;
      hashtags?: string[];
      beats?: Array<{ timeRange: string; visual: string; voiceover: string }>;
    };
  };
  createdAt: string;
  project?: { id: string; name: string; niche: string };
}

export function ContentLibraryView({ workspaceId }: { workspaceId: string }) {
  const [assets, setAssets] = useState<ContentAssetDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [voiceoverDraft, setVoiceoverDraft] = useState("");
  const [captionDraft, setCaptionDraft] = useState("");

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const query = typeFilter !== "ALL" ? "?type=" + typeFilter : "";
      const res = await apiFetch<{ assets: ContentAssetDTO[] }>("/workspaces/" + workspaceId + "/assets" + query);
      setAssets(res.assets);
      if (res.assets.length > 0) {
        setSelectedId((prev) => prev ?? res.assets[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, typeFilter]);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  const selected = assets.find((a) => a.id === selectedId) ?? assets[0];

  useEffect(() => {
    setVoiceoverDraft(selected?.metadata?.script?.voiceoverScript ?? "");
    setCaptionDraft(selected?.metadata?.script?.caption ?? "");
  }, [selected?.id]);

  async function handleApproval(approvalStatus: "APPROVED" | "REJECTED") {
    if (!selected) return;
    setSaving(true);
    try {
      await apiFetch("/workspaces/" + workspaceId + "/assets/" + selected.id, {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus }),
      });
      await loadAssets();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdits() {
    if (!selected) return;
    setSaving(true);
    try {
      const updatedScript = {
        ...(selected.metadata?.script ?? {}),
        voiceoverScript: voiceoverDraft,
        caption: captionDraft,
      };
      await apiFetch("/workspaces/" + workspaceId + "/assets/" + selected.id, {
        method: "PATCH",
        body: JSON.stringify({ script: updatedScript }),
      });
      await loadAssets();
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-xs text-zinc-400"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading content assets...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        {["ALL", "SCRIPT", "VIDEO"].map((t) => (
          <button
            key={t}
            onClick={() => { setTypeFilter(t); setSelectedId(null); }}
            className={"rounded-lg border px-3 py-1.5 text-xs font-medium transition " + (typeFilter === t ? "border-indigo-500 bg-indigo-500/15 text-indigo-300" : "border-zinc-800 bg-[#111114] text-zinc-400 hover:text-zinc-200")}
          >
            {t}
          </button>
        ))}
      </div>

      {assets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-[#111114] p-12 text-center text-xs text-zinc-400">
          No content assets generated yet. Run any channel production pipeline to populate scripts and render manifests here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-2.5">
            {assets.map((asset) => {
              const approval = asset.metadata?.approvalStatus ?? "PENDING_REVIEW";
              return (
                <button
                  key={asset.id}
                  onClick={() => setSelectedId(asset.id)}
                  className={"w-full text-left rounded-xl border p-4 transition " + (asset.id === selected?.id ? "border-indigo-500/60 bg-zinc-900" : "border-zinc-800 bg-[#111114] hover:border-zinc-700")}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
                      {asset.type === "VIDEO" ? <Video className="h-3.5 w-3.5 text-emerald-400" /> : <FileText className="h-3.5 w-3.5 text-indigo-400" />}
                      {asset.fileName}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-zinc-500 mt-2">
                    <span>{asset.project?.name}</span>
                    <StatusBadge status={approval} />
                  </div>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="lg:col-span-2 rounded-xl border border-zinc-800 bg-[#111114] p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">{selected.fileName}</h2>
                  <p className="text-xs text-zinc-500 font-mono mt-0.5">{selected.storageKey}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleApproval("APPROVED")} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/30">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                  </button>
                  <button onClick={() => handleApproval("REJECTED")} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600/20 border border-rose-500/30 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-600/30">
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </button>
                </div>
              </div>

              {selected.metadata?.script?.hook && (
                <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400 mb-1">Opening Hook (0:00?0:03)</p>
                  <p className="text-xs text-zinc-100">{selected.metadata.script.hook}</p>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Voiceover Narration (Editable)</label>
                <textarea rows={4} value={voiceoverDraft} onChange={(e) => setVoiceoverDraft(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none" />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Publishing Caption</label>
                <input value={captionDraft} onChange={(e) => setCaptionDraft(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none" />
              </div>

              <div className="flex items-center justify-between pt-2">
                <a
                  href={(process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1") + "/workspaces/" + workspaceId + "/assets/" + selected.id + "/download"}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
                >
                  <Download className="h-3.5 w-3.5" /> Export JSON Package
                </a>
                <button onClick={handleSaveEdits} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500">
                  <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : "Save Script Edits"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
