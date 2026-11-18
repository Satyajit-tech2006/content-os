"use client";
import React, { useEffect, useState, useCallback } from "react";
import { ArrowLeft, Play, Settings, Pause, Trash2, CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, Film, Terminal, RotateCcw, ShieldAlert } from "lucide-react";
import { apiFetch, type ProjectDTO, type WorkflowExecutionDTO } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";
import { LiveClipperPanel } from "./LiveClipperPanel";

interface Props {
  workspaceId: string; projectId: string;
  onBack: () => void; onEdit: (project: ProjectDTO) => void; onDeleted: () => void;
}

export function ProjectDetailView({ workspaceId, projectId, onBack, onEdit, onDeleted }: Props) {
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [selectedExecId, setSelectedExecId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [durationRange, setDurationRange] = useState<string>("30-45s");
  const [videoStyle, setVideoStyle] = useState("isometric_tech");
  const [voiceTone, setVoiceTone] = useState("energetic");
  const [simulateFailureAtStage, setSimulateFailureAtStage] = useState("");
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const res = await apiFetch<{ project: ProjectDTO }>("/workspaces/" + workspaceId + "/projects/" + projectId);
      setProject(res.project);
      if (res.project.executions && res.project.executions.length > 0) {
        setSelectedExecId((prev) => prev ?? res.project.executions![0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    }
  }, [workspaceId, projectId]);

  useEffect(() => { loadProject(); }, [loadProject]);

  useEffect(() => {
    const hasActiveRun = project?.executions?.some((e) => e.status === "PENDING" || e.status === "RUNNING");
    if (!hasActiveRun) return;
    const timer = setInterval(loadProject, 1200);
    return () => clearInterval(timer);
  }, [project, loadProject]);

  async function handleRunWorkflow(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTriggering(true);
    try {
      const res = await apiFetch<{ execution: WorkflowExecutionDTO }>(
        "/workspaces/" + workspaceId + "/executions/projects/" + projectId + "/run",
        {
          method: "POST",
          body: JSON.stringify({
            topic: topic.trim() || undefined,
            durationRange,
            videoStyle,
          tone: voiceTone,
            simulateFailureAtStage: simulateFailureAtStage || undefined,
          }),
        }
      );
      setTopic("");
      setSelectedExecId(res.execution.id);
      await loadProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger workflow");
    } finally {
      setTriggering(false);
    }
  }

  async function handleToggleStatus() {
    if (!project) return;
    const nextStatus = project.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    await apiFetch("/workspaces/" + workspaceId + "/projects/" + project.id, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadProject();
  }

  async function handleRetryExecution(executionId: string) {
    setError(null);
    try {
      await apiFetch("/workspaces/" + workspaceId + "/executions/" + executionId + "/retry", {
        method: "POST",
      });
      await loadProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry execution");
    }
  }

  async function handleDelete() {
    if (!project) return;
    if (!window.confirm("Delete project '" + project.name + "' and all execution history?")) return;
    await apiFetch("/workspaces/" + workspaceId + "/projects/" + project.id, { method: "DELETE" });
    onDeleted();
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading channel workspace...
      </div>
    );
  }

  const activeExecution = project.executions?.find((e) => e.id === selectedExecId) ?? project.executions?.[0];
  const allLogs = activeExecution?.stages.flatMap((s) => (s.logs || []).map((l) => ({ ...l, stageName: s.stageName }))) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-lg border border-zinc-800 bg-[#111114] p-2 text-zinc-400 hover:text-zinc-100"><ArrowLeft className="h-4 w-4" /></button>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold text-zinc-100">{project.name}</h1>
              <StatusBadge status={project.status} />
            </div>
            <p className="text-sm text-zinc-400">{project.description || project.niche}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleToggleStatus} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#111114] px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800">
            {project.status === "ACTIVE" ? <><Pause className="h-3.5 w-3.5 text-amber-400" /> Pause Channel</> : <><Play className="h-3.5 w-3.5 text-emerald-400" /> Activate Channel</>}
          </button>
          <button onClick={() => onEdit(project)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#111114] px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800">
            <Settings className="h-3.5 w-3.5" /> Edit Config
          </button>
          <button onClick={handleDelete} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-400 hover:bg-rose-500/20">
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-100">Channel Configuration</h2>
          <dl className="space-y-2.5 text-xs">
            <div className="flex justify-between"><dt className="text-zinc-500">Niche</dt><dd className="text-zinc-200 font-medium">{project.niche}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Target Audience</dt><dd className="text-zinc-200 text-right max-w-[180px]">{project.targetAudience}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Workflow</dt><dd className="text-indigo-400 font-medium">{project.workflowTemplate?.name}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Platforms</dt><dd className="text-zinc-200 capitalize">{project.platforms.join(", ")}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Cadence</dt><dd className="text-zinc-200">{project.postingFrequency} posts / week</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Approval Gate</dt><dd className="text-zinc-200">{project.approvalRequired ? "Required" : "Auto-bypass"}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Automation</dt><dd className="text-zinc-200">{project.automationEnabled ? "Enabled" : "Manual Trigger"}</dd></div>
          </dl>
          <div className="border-t border-zinc-800 pt-4">
            <h3 className="text-xs font-semibold text-zinc-300 mb-2.5">Trigger Workflow Run (BullMQ Worker)</h3>
            <form onSubmit={handleRunWorkflow} className="space-y-3">
              <textarea rows={2} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic or detailed prompt angle..." className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] text-zinc-500 mb-1">Duration Range</label>
                  <select value={durationRange} onChange={(e) => setDurationRange(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200">
                    <option value="15-20s">15?20 sec (Snappy Short)</option>
                    <option value="30-45s">30?45 sec (Standard Reel)</option>
                    <option value="45-60s">45?60 sec (Deep Explainer)</option>
                    <option value="60s+">60s+ (Extended Story)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-500 mb-1">Visual Video Style</label>
                  <select value={videoStyle} onChange={(e) => setVideoStyle(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200">
                    <option value="isometric_tech">0. Isometric Motion Graphics (3D Explainers)</option>
                    <option value="stickman_explainer">1. Stickman Animation (Story-Driven Dynamic)</option>
                    <option value="minimal_line_art">2. Normal Lines Info Reels (Clean Vector Motion)</option>
                    <option value="phonk_montage_edit">3. Anime &amp; Phonk Montage Edits</option>
                    <option value="stock_ken_burns">4. Stock Image Info Reels</option>
                    <option value="product_review_showcase">5. Product Review &amp; Model Showcase (e.g. Casio Watch)</option>
                  </select>
                </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                Voice &amp; Script Tone
              </label>
              <select
                value={voiceTone}
                onChange={(e) => setVoiceTone(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="energetic">Energetic &amp; Punchy (Guy Neural ? English)</option>
                <option value="engaging">Natural Host (Andrew Neural ? English)</option>
                <option value="documentary">Warm Storyteller (Aria Neural ? English)</option>
                <option value="hindi_madhur">Hindi Male ? Madhur Neural (Authoritative)</option>
                <option value="hindi_swara">Hindi Female ? Swara Neural (Storyteller)</option>
                <option value="hindi_kabir">Hindi Male ? Kabir Energetic (Reels / YouTube)</option>
                <option value="hindi_kavya">Hindi Female ? Kavya Documentary (Calm Hindi)</option>
              </select>
            </div>
              </div>
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1">Test Failure Handling (Optional)</label>
                <select value={simulateFailureAtStage} onChange={(e) => setSimulateFailureAtStage(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300">
                  <option value="">Normal execution (all stages succeed)</option>
                  <option value="research">Simulate failure at: Research</option>
                  <option value="script_generation">Simulate failure at: Script Generation</option>
                  <option value="video_rendering">Simulate failure at: Video Rendering</option>
                  <option value="quality_control">Simulate failure at: Quality Control</option>
                </select>
              </div>
              <button type="submit" disabled={triggering || project.status !== "ACTIVE"} className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                <Play className="h-3.5 w-3.5" />
                {triggering ? "Dispatching to Queue..." : "Run Production Pipeline"}
              </button>
            </form>
          </div>
          <LiveClipperPanel workspaceId={workspaceId} projectId={project.id} />
        </div>
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Stage Pipeline Progression</h2>
                <p className="text-xs text-zinc-500">{activeExecution ? "Execution " + activeExecution.id.slice(0, 10) + "..." : "No executions yet ? run the pipeline to watch BullMQ stages progress"}</p>
              </div>
              {activeExecution && (
                <div className="flex items-center gap-2">
                  {activeExecution.status === "FAILED" && (
                    <button
                      onClick={() => handleRetryExecution(activeExecution.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/25"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Retry Failed Stage
                    </button>
                  )}
                  <StatusBadge status={activeExecution.status} />
                </div>
              )}
            </div>
            {activeExecution?.status === "AWAITING_APPROVAL" && (
              <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Paused at Human Approval Gate</p>
                  <p className="text-[11px] text-amber-300/90 mt-0.5">
                    Open <strong>Content Library</strong> in the left sidebar to review, edit, request revisions, or approve this script before publishing proceeds.
                  </p>
                </div>
              </div>
            )}
            {activeExecution ? (
              <div className="space-y-2.5">
                {activeExecution.stages.map((stage) => (
                  <div key={stage.id} className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3.5 py-2.5">
                    <div className="flex items-center gap-3">
                      {stage.status === "COMPLETED" && <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />}
                      {stage.status === "RUNNING" && <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />}
                      {(stage.status === "FAILED" || stage.status === "REJECTED") && <XCircle className="h-4 w-4 text-rose-400 shrink-0" />}
                      {stage.status === "AWAITING_APPROVAL" && <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />}
                      {stage.status === "PENDING" && <Clock className="h-4 w-4 text-zinc-600 shrink-0" />}
                      <div>
                        <p className="text-xs font-medium text-zinc-200">{stage.stageOrder + 1}. {stage.stageName}</p>
                        {stage.errorMessage && <p className="text-[11px] text-rose-400 mt-0.5">{stage.errorMessage}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {stage.attemptCount > 0 && <span className="text-[11px] text-zinc-500">Attempt {stage.attemptCount}</span>}
                      <StatusBadge status={stage.status} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-800 py-10 text-center text-xs text-zinc-500">Click "Run Production Pipeline" on the left to enqueue a real BullMQ workflow job.</div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
              <div className="flex items-center gap-2 mb-3"><Terminal className="h-4 w-4 text-indigo-400" /><h3 className="text-xs font-semibold text-zinc-100">Execution Logs</h3></div>
              <div className="h-52 overflow-y-auto rounded-lg bg-zinc-950 border border-zinc-800/80 p-3 font-mono text-[11px] space-y-1.5">
                {allLogs.length === 0 ? <p className="text-zinc-600">Waiting for worker stage logs...</p> : allLogs.map((entry, idx) => (
                  <div key={idx} className="leading-relaxed">
                    <span className="text-zinc-600">[{new Date(entry.timestamp).toLocaleTimeString()}]</span>{" "}
                    <span className="text-indigo-400">[{entry.stageName}]</span>{" "}
                    <span className={entry.level === "error" ? "text-rose-400" : "text-zinc-300"}>{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2"><Film className="h-4 w-4 text-emerald-400" /><h3 className="text-xs font-semibold text-zinc-100">Generated Output Preview</h3></div>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Ollama Local AI</span>
              </div>
              {activeExecution?.outputSummary &&
                Object.keys(activeExecution.outputSummary).length > 0 ? (
                  <pre className="h-52 overflow-y-auto rounded-lg bg-zinc-950 border border-zinc-800/80 p-3 font-mono text-[11px] text-emerald-300/90 whitespace-pre-wrap">
                    {JSON.stringify(activeExecution.outputSummary, null, 2)}
                  </pre>
                ) : (
                  <div className="h-52 flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 p-4 text-center">
                    <p className="text-xs text-zinc-400">
                      Trigger a production pipeline run to view live Ollama-generated briefs and scripts here.
                    </p>
                  </div>
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
