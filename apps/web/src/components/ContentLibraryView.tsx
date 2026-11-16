"use client";
import React, { useEffect, useState, useCallback } from "react";
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  FileText,
  Video,
  Save,
  Loader2,
  Download,
  History,
  ShieldCheck,
  MessageSquareWarning,
  Sparkles,
  UserCheck,
} from "lucide-react";
import {
  apiFetch,
  type ContentRevisionDTO,
  type ApprovalDecisionDTO,
} from "@/lib/api";
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
  approvalStatus: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "REVISION_REQUESTED";
  currentRevisionNum: number;
  approvedRevisionId: string | null;
  metadata: {
    title?: string;
    approvalStatus?: string;
    script?: {
      title?: string;
      hook?: string;
      voiceoverScript?: string;
      caption?: string;
      description?: string;
      hashtags?: string[];
    };
  };
  createdAt: string;
  project?: { id: string; name: string; niche: string };
  execution?: {
    id: string;
    status: string;
    currentStageIndex: number;
    activeRevisionNum: number;
    approvedRevisionId: string | null;
  } | null;
  revisions?: ContentRevisionDTO[];
  approvalDecisions?: ApprovalDecisionDTO[];
}

const APPROVAL_FILTERS = [
  { key: "ALL", label: "All Content" },
  { key: "PENDING_APPROVAL", label: "Pending Review" },
  { key: "REVISION_REQUESTED", label: "Revision Requested" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
] as const;

export function ContentLibraryView({ workspaceId }: { workspaceId: string }) {
  const [assets, setAssets] = useState<ContentAssetDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRevId, setSelectedRevId] = useState<string | null>(null);
  const [approvalFilter, setApprovalFilter] = useState<string>("ALL");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);

  // Editable draft fields (bound to latest revision)
  const [titleDraft, setTitleDraft] = useState("");
  const [hookDraft, setHookDraft] = useState("");
  const [voiceoverDraft, setVoiceoverDraft] = useState("");
  const [captionDraft, setCaptionDraft] = useState("");
  const [hashtagsDraft, setHashtagsDraft] = useState("");

  // Review feedback state
  const [reviewComment, setReviewComment] = useState("");
  const [showRevisionBox, setShowRevisionBox] = useState(false);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const query = approvalFilter !== "ALL" ? "?approvalStatus=" + approvalFilter : "";
      const res = await apiFetch<{ assets: ContentAssetDTO[] }>(
        "/workspaces/" + workspaceId + "/assets" + query
      );
      setAssets(res.assets);
      if (res.assets.length > 0) {
        setSelectedId((prev) =>
          prev && res.assets.some((a) => a.id === prev) ? prev : res.assets[0].id
        );
      } else {
        setSelectedId(null);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, approvalFilter]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  const selected = assets.find((a) => a.id === selectedId) ?? assets[0];
  const revisions = selected?.revisions ?? [];
  const latestRevision = revisions[0];
  const viewedRevision =
    revisions.find((r) => r.id === selectedRevId) ?? latestRevision;
  const isViewingLatest = !viewedRevision || viewedRevision.id === latestRevision?.id;

  useEffect(() => {
    setSelectedRevId(latestRevision?.id ?? null);
    setTitleDraft(
      latestRevision?.title ??
        selected?.metadata?.script?.title ??
        selected?.fileName ??
        ""
    );
    setHookDraft(
      latestRevision?.hook ?? selected?.metadata?.script?.hook ?? ""
    );
    setVoiceoverDraft(
      latestRevision?.voiceoverScript ??
        selected?.metadata?.script?.voiceoverScript ??
        ""
    );
    setCaptionDraft(
      latestRevision?.description ??
        selected?.metadata?.script?.description ??
        selected?.metadata?.script?.caption ??
        ""
    );
    const tags =
      latestRevision?.hashtags ?? selected?.metadata?.script?.hashtags ?? [];
    setHashtagsDraft(tags.join(", "));
    setReviewComment("");
    setShowRevisionBox(false);
    setFeedbackError(null);
  }, [selected?.id, latestRevision?.id]);

  async function handleReviewDecision(
    decision: "APPROVED" | "REJECTED" | "REVISION_REQUESTED"
  ) {
    if (!selected) return;
    setFeedbackError(null);
    setActionBanner(null);

    if (decision === "REVISION_REQUESTED" && !reviewComment.trim()) {
      setShowRevisionBox(true);
      setFeedbackError("Please enter specific revision feedback for the AI writer before requesting a revision.");
      return;
    }

    setSaving(true);
    try {
      const idempotencyKey = `review:${selected.id}:rev:${latestRevision?.id ?? "0"}:${decision}:${Date.now()}`;
      await apiFetch("/workspaces/" + workspaceId + "/assets/" + selected.id + "/review", {
        method: "POST",
        body: JSON.stringify({
          decision,
          comment: reviewComment.trim() || undefined,
          revisionId: latestRevision?.id,
          idempotencyKey,
        }),
      });
      setReviewComment("");
      setShowRevisionBox(false);
      setActionBanner(
        decision === "APPROVED"
          ? "Revision approved and pinned for publishing."
          : decision === "REVISION_REQUESTED"
            ? "Revision requested ? AI script regeneration queued with your feedback."
            : "Content rejected and workflow halted."
      );
      await loadAssets();
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to submit review decision");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveNewRevision() {
    if (!selected) return;
    setFeedbackError(null);
    setActionBanner(null);
    setSaving(true);
    try {
      const parsedTags = hashtagsDraft
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      await apiFetch("/workspaces/" + workspaceId + "/assets/" + selected.id, {
        method: "PATCH",
        body: JSON.stringify({
          title: titleDraft.trim() || selected.fileName,
          hook: hookDraft.trim(),
          voiceoverScript: voiceoverDraft,
          description: captionDraft,
          hashtags: parsedTags,
        }),
      });
      setActionBanner("Saved as a new immutable revision (status reset to Pending Approval).");
      await loadAssets();
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to save revision");
    } finally {
      setSaving(false);
    }
  }

  const pendingCount = assets.filter((a) => a.approvalStatus === "PENDING_APPROVAL").length;
  const canReview =
    selected?.execution?.status === "AWAITING_APPROVAL" && isViewingLatest;

  if (loading) {
    return (
      <div className="py-12 text-center text-xs text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
        Loading content library & revision history...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {APPROVAL_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setApprovalFilter(f.key);
                setSelectedId(null);
              }}
              className={
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
                (approvalFilter === f.key
                  ? "border-indigo-500 bg-indigo-500/15 text-indigo-300"
                  : "border-zinc-800 bg-[#111114] text-zinc-400 hover:text-zinc-200")
              }
            >
              {f.label}
              {f.key === "PENDING_APPROVAL" && approvalFilter === "ALL" && pendingCount > 0 && (
                <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-amber-300">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {feedbackError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          {feedbackError}
        </div>
      )}

      {actionBanner && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">
          {actionBanner}
        </div>
      )}

      {assets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-[#111114] p-12 text-center text-xs text-zinc-400">
          No content assets match this filter. Run a channel production pipeline to generate scripts for review.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left Column: Asset Queue */}
          <div className="space-y-2.5">
            {assets.map((asset) => {
              const status = asset.approvalStatus || asset.metadata?.approvalStatus || "PENDING_APPROVAL";
              return (
                <button
                  key={asset.id}
                  onClick={() => setSelectedId(asset.id)}
                  className={
                    "w-full text-left rounded-xl border p-4 transition " +
                    (asset.id === selected?.id
                      ? "border-indigo-500/60 bg-zinc-900"
                      : "border-zinc-800 bg-[#111114] hover:border-zinc-700")
                  }
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-100 line-clamp-1">
                      {asset.type === "RENDERED_VIDEO" ? (
                        <Video className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                      )}
                      {asset.fileName}
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 shrink-0">
                      v{asset.currentRevisionNum || 1}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-zinc-500 mt-2">
                    <span className="truncate max-w-[140px]">{asset.project?.name}</span>
                    <StatusBadge status={status} />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right 2 Columns: Revision Inspector, HITL Review Gate & Audit Trail */}
          {selected && (
            <div className="lg:col-span-2 space-y-6">
              <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6 space-y-5">
                {/* Header & Review Actions */}
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-zinc-100">{selected.fileName}</h2>
                      <StatusBadge status={selected.approvalStatus} />
                    </div>
                    <p className="text-xs text-zinc-500 font-mono mt-1">
                      Execution: {selected.execution?.status ?? "UNLINKED"} ? Active Rev: v{selected.currentRevisionNum}
                      {selected.approvedRevisionId ? " ? Pinned for Publishing" : ""}
                    </p>
                  </div>

                  {/* HITL Review Action Buttons */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => handleReviewDecision("APPROVED")}
                      disabled={saving || !canReview}
                      title={!canReview ? "Execution must be in AWAITING_APPROVAL on the latest revision" : "Approve and release to publishing"}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      onClick={() => setShowRevisionBox((v) => !v)}
                      disabled={saving || !canReview}
                      title={!canReview ? "Execution must be in AWAITING_APPROVAL on the latest revision" : "Request AI revision with feedback"}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600/20 border border-amber-500/30 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Request Revision
                    </button>
                    <button
                      onClick={() => handleReviewDecision("REJECTED")}
                      disabled={saving || !canReview}
                      title={!canReview ? "Execution must be in AWAITING_APPROVAL on the latest revision" : "Reject content permanently"}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600/20 border border-rose-500/30 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                </div>

                {/* Inline Revision Feedback Drawer */}
                {showRevisionBox && canReview && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                      <MessageSquareWarning className="h-4 w-4" />
                      Reviewer Instructions for AI Script Regeneration
                    </div>
                    <textarea
                      rows={3}
                      value={reviewComment}
                      onChange={(e) => setReviewComment(e.target.value)}
                      placeholder="e.g., Make the opening hook punchier in the first 2 seconds, tighten the pacing, and emphasize concrete numbers..."
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setShowRevisionBox(false)}
                        className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleReviewDecision("REVISION_REQUESTED")}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        {saving ? "Submitting..." : "Send Feedback & Regenerate"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Immutable Revision Selector Pills */}
                {revisions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                      <History className="h-3.5 w-3.5 text-indigo-400" />
                      Immutable Revision History ({revisions.length})
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {revisions.map((rev) => {
                        const isSelectedRev = viewedRevision?.id === rev.id;
                        const isApprovedRev = selected.approvedRevisionId === rev.id;
                        return (
                          <button
                            key={rev.id}
                            onClick={() => setSelectedRevId(rev.id)}
                            className={
                              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition " +
                              (isSelectedRev
                                ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                                : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200")
                            }
                          >
                            <span className="font-mono font-semibold">v{rev.revisionNumber}</span>
                            <span className="text-[10px] opacity-80">
                              {rev.source === "AI_GENERATED"
                                ? "AI Initial"
                                : rev.source === "AI_REVISION"
                                  ? "AI Revised"
                                  : "Manual Edit"}
                            </span>
                            {isApprovedRev && (
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Viewed Revision Provenance Banner */}
                {viewedRevision && (
                  <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/70 px-3.5 py-2.5 text-[11px] text-zinc-400 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Viewing <strong className="text-zinc-200">v{viewedRevision.revisionNumber}</strong> ? Created{" "}
                      {new Date(viewedRevision.createdAt).toLocaleString()}
                      {viewedRevision.provider && viewedRevision.model
                        ? ` ? ${viewedRevision.provider}/${viewedRevision.model}`
                        : ""}
                      {viewedRevision.createdByUser
                        ? ` ? by ${viewedRevision.createdByUser.email}`
                        : ""}
                    </span>
                    {!isViewingLatest && (
                      <button
                        onClick={() => setSelectedRevId(latestRevision?.id ?? null)}
                        className="text-indigo-400 hover:underline font-medium"
                      >
                        Jump to latest (v{latestRevision?.revisionNumber})
                      </button>
                    )}
                  </div>
                )}

                {viewedRevision?.reviewerFeedback && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
                    <span className="font-semibold">Triggered by Reviewer Feedback: </span>
                    {viewedRevision.reviewerFeedback}
                  </div>
                )}

                {/* Script Fields (Editable on Latest Revision, Read-only Snapshot on Historical Revisions) */}
                {isViewingLatest ? (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-zinc-400 mb-1">Episode / Asset Title</label>
                      <input
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-indigo-400 mb-1">Opening Hook (0:00?0:03)</label>
                      <input
                        value={hookDraft}
                        onChange={(e) => setHookDraft(e.target.value)}
                        className="w-full rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-400 mb-1">Voiceover Narration Script</label>
                      <textarea
                        rows={6}
                        value={voiceoverDraft}
                        onChange={(e) => setVoiceoverDraft(e.target.value)}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-100 leading-relaxed focus:border-indigo-500 focus:outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">Publishing Caption / Description</label>
                        <input
                          value={captionDraft}
                          onChange={(e) => setCaptionDraft(e.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">Hashtags (comma-separated)</label>
                        <input
                          value={hashtagsDraft}
                          onChange={(e) => setHashtagsDraft(e.target.value)}
                          placeholder="#ai, #tech, #shorts"
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-xs">
                    <div>
                      <span className="text-zinc-500 block text-[11px]">Historical Title (Read-Only Snapshot)</span>
                      <p className="text-zinc-100 font-medium mt-0.5">{viewedRevision?.title}</p>
                    </div>
                    {viewedRevision?.hook && (
                      <div>
                        <span className="text-indigo-400 block text-[11px]">Hook</span>
                        <p className="text-zinc-200 mt-0.5">{viewedRevision.hook}</p>
                      </div>
                    )}
                    <div>
                      <span className="text-zinc-500 block text-[11px]">Voiceover Script</span>
                      <p className="text-zinc-200 whitespace-pre-wrap mt-0.5 leading-relaxed">
                        {viewedRevision?.voiceoverScript}
                      </p>
                    </div>
                    {viewedRevision?.description && (
                      <div>
                        <span className="text-zinc-500 block text-[11px]">Caption</span>
                        <p className="text-zinc-300 mt-0.5">{viewedRevision.description}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Footer Actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-800/80">
                  <a
                    href={
                      (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1") +
                      "/workspaces/" +
                      workspaceId +
                      "/assets/" +
                      selected.id +
                      "/download"
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
                  >
                    <Download className="h-3.5 w-3.5" /> Export Full Revision JSON
                  </a>

                  {isViewingLatest && (
                    <button
                      onClick={handleSaveNewRevision}
                      disabled={saving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      <Save className="h-3.5 w-3.5" />
                      {saving ? "Creating Revision..." : `Save as New Revision (v${selected.currentRevisionNum + 1})`}
                    </button>
                  )}
                </div>
              </div>

              {/* Approval Audit Trail */}
              {selected.approvalDecisions && selected.approvalDecisions.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                    <UserCheck className="h-4 w-4 text-emerald-400" />
                    Human Review & Approval Audit Log
                  </div>
                  <div className="space-y-2">
                    {selected.approvalDecisions.map((d) => (
                      <div
                        key={d.id}
                        className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3.5 py-2.5 text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <StatusBadge status={d.decision} />
                            {d.revision && (
                              <span className="font-mono text-[11px] text-zinc-400">
                                on v{d.revision.revisionNumber}
                              </span>
                            )}
                            <span className="text-zinc-400">
                              by <strong className="text-zinc-200">{d.reviewer?.email ?? "Reviewer"}</strong>
                            </span>
                          </div>
                          {d.comment && <p className="text-zinc-300 text-[11px] pt-1">"{d.comment}"</p>}
                        </div>
                        <span className="text-[11px] text-zinc-500">
                          {new Date(d.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
