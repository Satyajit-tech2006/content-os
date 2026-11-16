"use client";
import React, { useEffect, useState } from "react";
import { Cpu, Coins, Hash } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface UsageResponse {
  totals: { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  records: Array<{
    id: string; provider: string; model: string; stageKey: string | null;
    inputTokens: number; outputTokens: number; estimatedCostUsd: number; createdAt: string;
  }>;
}

export function AnalyticsView({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<UsageResponse | null>(null);

  useEffect(() => {
    apiFetch<UsageResponse>("/workspaces/" + workspaceId + "/usage").then(setData).catch(() => {});
  }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
          <div className="flex items-center justify-between text-zinc-400 mb-2"><span className="text-xs">AI Inference Calls</span><Cpu className="h-4 w-4 text-indigo-400" /></div>
          <p className="text-2xl font-semibold text-zinc-100">{data?.totals.calls ?? 0}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
          <div className="flex items-center justify-between text-zinc-400 mb-2"><span className="text-xs">Total Tokens Processed</span><Hash className="h-4 w-4 text-sky-400" /></div>
          <p className="text-2xl font-semibold text-zinc-100">{((data?.totals.inputTokens ?? 0) + (data?.totals.outputTokens ?? 0)).toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
          <div className="flex items-center justify-between text-zinc-400 mb-2"><span className="text-xs">Estimated Spend (USD)</span><Coins className="h-4 w-4 text-emerald-400" /></div>
          <p className="text-2xl font-semibold text-zinc-100">${(data?.totals.estimatedCostUsd ?? 0).toFixed(4)}</p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6">
        <h2 className="text-sm font-semibold text-zinc-100 mb-4">AI Token & Cost Ledger</h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500">
              <th className="pb-2">Provider / Model</th><th className="pb-2">Stage</th><th className="pb-2">Input Tokens</th><th className="pb-2">Output Tokens</th><th className="pb-2">Est. Cost</th><th className="pb-2">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {(data?.records ?? []).map((r) => (
              <tr key={r.id}>
                <td className="py-2.5 text-zinc-200">{r.provider} ? <span className="text-indigo-400">{r.model}</span></td>
                <td className="py-2.5 font-mono text-zinc-400">{r.stageKey ?? "?"}</td>
                <td className="py-2.5 text-zinc-300">{r.inputTokens.toLocaleString()}</td>
                <td className="py-2.5 text-zinc-300">{r.outputTokens.toLocaleString()}</td>
                <td className="py-2.5 text-emerald-400">${Number(r.estimatedCostUsd).toFixed(5)}</td>
                <td className="py-2.5 text-zinc-500">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {(!data?.records || data.records.length === 0) && <tr><td colSpan={6} className="py-6 text-center text-zinc-500">No AI usage records logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
