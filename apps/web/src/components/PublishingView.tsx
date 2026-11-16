"use client";
import React, { useEffect, useState, useCallback } from "react";
import { Send, Plus, Trash2, Link2, CheckCircle2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";
import type { ContentAssetDTO } from "./ContentLibraryView";

interface ConnectionDTO {
  id: string; platform: string; accountName: string; externalAccountId: string; status: string;
}
interface PublishRecordDTO {
  id: string; status: string; externalPostId: string | null; publishedAt: string | null; createdAt: string;
  project?: { name: string }; asset?: { fileName: string; type: string };
  platformConnection?: { platform: string; accountName: string };
}

export function PublishingView({ workspaceId }: { workspaceId: string }) {
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [records, setRecords] = useState<PublishRecordDTO[]>([]);
  const [assets, setAssets] = useState<ContentAssetDTO[]>([]);
  const [platform, setPlatform] = useState("youtube");
  const [accountName, setAccountName] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [selectedConnId, setSelectedConnId] = useState("");
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    const [cRes, rRes, aRes] = await Promise.all([
      apiFetch<{ connections: ConnectionDTO[] }>("/workspaces/" + workspaceId + "/publishing/connections"),
      apiFetch<{ records: PublishRecordDTO[] }>("/workspaces/" + workspaceId + "/publishing/records"),
      apiFetch<{ assets: ContentAssetDTO[] }>("/workspaces/" + workspaceId + "/assets"),
    ]);
    setConnections(cRes.connections);
    setRecords(rRes.records);
    setAssets(aRes.assets);
    if (cRes.connections[0]) setSelectedConnId((p) => p || cRes.connections[0].id);
    if (aRes.assets[0]) setSelectedAssetId((p) => p || aRes.assets[0].id);
  }, [workspaceId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch("/workspaces/" + workspaceId + "/publishing/connections", {
        method: "POST",
        body: JSON.stringify({ platform, accountName, externalAccountId }),
      });
      setAccountName("");
      setExternalAccountId("");
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function handleDispatch(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedAssetId || !selectedConnId) return;
    setBusy(true);
    try {
      await apiFetch("/workspaces/" + workspaceId + "/publishing/dispatch", {
        method: "POST",
        body: JSON.stringify({ assetId: selectedAssetId, platformConnectionId: selectedConnId }),
      });
      await loadAll();
      setTimeout(loadAll, 1500);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveConn(id: string) {
    await apiFetch("/workspaces/" + workspaceId + "/publishing/connections/" + id, { method: "DELETE" });
    await loadAll();
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6 space-y-4">
          <div className="flex items-center gap-2"><Link2 className="h-4 w-4 text-indigo-400" /><h2 className="text-sm font-semibold text-zinc-100">Connected Channel Accounts</h2></div>
          <form onSubmit={handleConnect} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100">
              <option value="youtube">YouTube</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="x">X (Twitter)</option>
            </select>
            <input required value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="@checkpointdaily" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100" />
            <input required value={externalAccountId} onChange={(e) => setExternalAccountId(e.target.value)} placeholder="Channel ID" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100" />
            <button type="submit" disabled={busy} className="sm:col-span-3 inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 py-2 text-xs font-medium text-zinc-100">
              <Plus className="h-3.5 w-3.5" /> Connect Social Account
            </button>
          </form>
          <div className="divide-y divide-zinc-800/80">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2.5 text-xs">
                <div><span className="capitalize font-semibold text-indigo-400">{c.platform}</span> ? <span className="text-zinc-200">{c.accountName}</span></div>
                <button onClick={() => handleRemoveConn(c.id)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            {connections.length === 0 && <p className="py-3 text-xs text-zinc-500">No platform accounts connected yet.</p>}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6 space-y-4">
          <div className="flex items-center gap-2"><Send className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-semibold text-zinc-100">Dispatch Asset to Publishing Queue</h2></div>
          <form onSubmit={handleDispatch} className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Select Content Asset</label>
              <select value={selectedAssetId} onChange={(e) => setSelectedAssetId(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100">
                {assets.map((a) => <option key={a.id} value={a.id}>{a.fileName} ({a.type})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Target Destination Account</label>
              <select value={selectedConnId} onChange={(e) => setSelectedConnId(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100">
                {connections.map((c) => <option key={c.id} value={c.id}>{c.platform.toUpperCase()} ? {c.accountName}</option>)}
              </select>
            </div>
            <button type="submit" disabled={busy || !selectedAssetId || !selectedConnId} className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              <CheckCircle2 className="h-3.5 w-3.5" /> Queue & Publish Now
            </button>
          </form>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6">
        <h3 className="text-sm font-semibold text-zinc-100 mb-4">Publishing Dispatch Log</h3>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500">
              <th className="pb-2">Asset</th><th className="pb-2">Platform</th><th className="pb-2">External Post ID</th><th className="pb-2">Status</th><th className="pb-2">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {records.map((r) => (
              <tr key={r.id}>
                <td className="py-2.5 text-zinc-200">{r.asset?.fileName}</td>
                <td className="py-2.5 capitalize text-indigo-400">{r.platformConnection?.platform} ({r.platformConnection?.accountName})</td>
                <td className="py-2.5 font-mono text-zinc-400">{r.externalPostId ?? "?"}</td>
                <td className="py-2.5"><StatusBadge status={r.status} /></td>
                <td className="py-2.5 text-zinc-500">{new Date(r.publishedAt ?? r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {records.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-zinc-500">No publishing records dispatched yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
