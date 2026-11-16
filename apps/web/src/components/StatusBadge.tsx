import React from "react";

const STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  COMPLETED: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  APPROVED: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  RUNNING: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20 animate-pulse",
  PENDING: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  PENDING_APPROVAL: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  AWAITING_APPROVAL: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  REVISION_REQUESTED: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  PAUSED: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  FAILED: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  REJECTED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  CANCELLED: "bg-zinc-500/10 text-zinc-500 border-zinc-700",
  ARCHIVED: "bg-zinc-800 text-zinc-500 border-zinc-700",
};

const LABELS: Record<string, string> = {
  PENDING_APPROVAL: "Pending Approval",
  AWAITING_APPROVAL: "Awaiting Approval",
  REVISION_REQUESTED: "Revision Requested",
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STYLES[status] || "bg-zinc-800 text-zinc-300 border-zinc-700";
  const label = LABELS[status] || status;
  return (
    <span className={"inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border " + cls}>
      {label}
    </span>
  );
}
