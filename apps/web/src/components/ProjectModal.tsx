"use client";
import React, { useState } from "react";
import { X } from "lucide-react";
import { apiFetch, type ProjectDTO, type WorkflowTemplateDTO } from "@/lib/api";

interface Props {
  workspaceId: string; templates: WorkflowTemplateDTO[]; initialProject?: ProjectDTO | null;
  onClose: () => void; onSaved: () => void;
}
const PLATFORMS = ["youtube", "instagram", "tiktok", "x"] as const;

export function ProjectModal({ workspaceId, templates, initialProject, onClose, onSaved }: Props) {
  const isEdit = Boolean(initialProject);
  const [name, setName] = useState(initialProject?.name ?? "");
  const [description, setDescription] = useState(initialProject?.description ?? "");
  const [niche, setNiche] = useState(initialProject?.niche ?? "");
  const [targetAudience, setTargetAudience] = useState(initialProject?.targetAudience ?? "");
  const [contentFormat, setContentFormat] = useState(initialProject?.contentFormat ?? "short_video");
  const [platforms, setPlatforms] = useState<string[]>(initialProject?.platforms ?? ["youtube", "instagram"]);
  const [postingFrequency, setPostingFrequency] = useState(initialProject?.postingFrequency ?? 5);
  const [workflowTemplateId, setWorkflowTemplateId] = useState(initialProject?.workflowTemplateId ?? templates[0]?.id ?? "tpl_short_form_v1");
  const [approvalRequired, setApprovalRequired] = useState(initialProject?.approvalRequired ?? true);
  const [automationEnabled, setAutomationEnabled] = useState(initialProject?.automationEnabled ?? false);
  const [tone, setTone] = useState(String(initialProject?.config?.tone ?? "engaging"));
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "16:9" | "1:1">((initialProject?.config?.aspectRatio as "9:16" | "16:9" | "1:1") ?? "9:16");
  const [targetDurationSec, setTargetDurationSec] = useState(Number(initialProject?.config?.targetDurationSec ?? 45));
  const [durationRange, setDurationRange] = useState(String(initialProject?.config?.durationRange ?? "30-45s"));
  const [videoStyle, setVideoStyle] = useState(String(initialProject?.config?.videoStyle ?? "stock_ken_burns"));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function togglePlatform(p: string) {
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((item) => item !== p) : [...prev, p]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name, description, niche, targetAudience, contentFormat, platforms,
        postingFrequency: Number(postingFrequency), workflowTemplateId, approvalRequired, automationEnabled,
        config: { tone, language: "en", aspectRatio, targetDurationSec: Number(targetDurationSec), durationRange, videoStyle },
      };
      if (isEdit && initialProject) {
        await apiFetch("/workspaces/" + workspaceId + "/projects/" + initialProject.id, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/workspaces/" + workspaceId + "/projects", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-[#111114] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-100">{isEdit ? "Configure Channel Project" : "Create New Channel Project"}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="max-h-[82vh] overflow-y-auto p-6 space-y-5">
          {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">{error}</div>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Channel Name</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkpoint Daily" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Niche</label>
              <input required value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. Gaming News" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Channel positioning and content focus..." className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Target Audience</label>
              <input required value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="e.g. Core gamers & PC enthusiasts" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Workflow Template</label>
              <select value={workflowTemplateId} onChange={(e) => setWorkflowTemplateId(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Target Platforms (Configuration)</label>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => {
                const active = platforms.includes(p);
                return <button type="button" key={p} onClick={() => togglePlatform(p)} className={"rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition " + (active ? "border-indigo-500 bg-indigo-500/15 text-indigo-300" : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700")}>{p}</button>;
              })}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Posts / Week</label>
              <input type="number" min={1} max={30} value={postingFrequency} onChange={(e) => setPostingFrequency(Number(e.target.value))} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Aspect Ratio</label>
              <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as "9:16" | "16:9" | "1:1")} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                <option value="9:16">9:16 (Vertical Short)</option>
                <option value="16:9">16:9 (Landscape)</option>
                <option value="1:1">1:1 (Square)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Duration Range</label>
              <select value={durationRange} onChange={(e) => setDurationRange(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                <option value="15-20s">15?20 sec</option>
                <option value="30-45s">30?45 sec</option>
                <option value="45-60s">45?60 sec</option>
                <option value="60s+">60s+</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Editorial Tone</label>
              <input value={tone} onChange={(e) => setTone(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Default Video Visual Style</label>
              <select value={videoStyle} onChange={(e) => setVideoStyle(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                <option value="stock_ken_burns">1. Stock Media + Ken Burns</option>
                <option value="stickman_explainer">2. Stickman Animation</option>
                <option value="minimal_line_art">3. Minimal Line-Art & Effects</option>
                <option value="kinetic_typography">4. Kinetic Typography</option>
                <option value="tech_hud_blueprint">5. Tech HUD / Blueprint</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Content Format</label>
              <select value={contentFormat} onChange={(e) => setContentFormat(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                <option value="short_video">Short-form Video</option>
                <option value="long_video">Long-form Video</option>
                <option value="carousel">Carousel</option>
                <option value="article">Article</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-6 pt-1">
            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={approvalRequired} onChange={(e) => setApprovalRequired(e.target.checked)} className="rounded border-zinc-700 bg-zinc-900 text-indigo-500" />
              Require Human Approval Gate
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={automationEnabled} onChange={(e) => setAutomationEnabled(e.target.checked)} className="rounded border-zinc-700 bg-zinc-900 text-indigo-500" />
              Automation Enabled
            </label>
          </div>
          <div className="flex justify-end gap-3 border-t border-zinc-800 pt-4">
            <button type="button" onClick={onClose} className="rounded-lg border border-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-900">Cancel</button>
            <button type="submit" disabled={submitting || platforms.length === 0} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {submitting ? "Saving..." : isEdit ? "Save Changes" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
