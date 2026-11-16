"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  LayoutDashboard,
  FolderKanban,
  Film,
  Workflow,
  Send,
  BarChart3,
  Settings,
  Plus,
  Layers,
  LogOut,
  Play,
  CheckCircle2,
  AlertCircle,
  Activity,
} from "lucide-react";
import {
  apiFetch,
  type ProjectDTO,
  type WorkflowExecutionDTO,
  type WorkflowTemplateDTO,
  type WorkspaceDTO,
} from "@/lib/api";
import { AuthScreen } from "./AuthScreen";
import { StatusBadge } from "./StatusBadge";
import { ProjectModal } from "./ProjectModal";
import { ProjectDetailView } from "./ProjectDetailView";
import { ContentLibraryView } from "./ContentLibraryView";
import { PublishingView } from "./PublishingView";
import { AnalyticsView } from "./AnalyticsView";

type NavSection =
  | "overview"
  | "projects"
  | "library"
  | "automation"
  | "publishing"
  | "analytics"
  | "settings";

interface OverviewResponse {
  stats: {
    totalProjects: number;
    activeProjects: number;
    totalExecutions: number;
    completedExecutions: number;
    failedExecutions: number;
    runningExecutions: number;
  };
  projects: ProjectDTO[];
  recentExecutions: WorkflowExecutionDTO[];
}

export function DashboardShell() {
  const [authState, setAuthState] = useState<"loading" | "unauthenticated" | "authenticated">("loading");
  const [user, setUser] = useState<{ id: string; name: string; email: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceDTO[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");
  const [activeNav, setActiveNav] = useState<NavSection>("overview");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplateDTO[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectDTO | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const me = await apiFetch<{
        user: { id: string; name: string; email: string };
        workspaces: WorkspaceDTO[];
      }>("/auth/me");
      setUser(me.user);
      setWorkspaces(me.workspaces);
      if (me.workspaces.length > 0) {
        setActiveWorkspaceId((prev) => prev || me.workspaces[0].id);
      }
      setAuthState("authenticated");
    } catch {
      setAuthState("unauthenticated");
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    if (!activeWorkspaceId) return;
    try {
      const tpl = await apiFetch<{ templates: WorkflowTemplateDTO[] }>(
        "/workspaces/" + activeWorkspaceId + "/templates"
      );
      setTemplates(tpl.templates);
    } catch {
      // Ignore transient abort
    }
  }, [activeWorkspaceId]);

  const loadWorkspaceData = useCallback(async () => {
    if (!activeWorkspaceId) return;
    try {
      const ov = await apiFetch<OverviewResponse>(
        "/workspaces/" + activeWorkspaceId + "/overview"
      );
      setOverview(ov);
    } catch {
      // Ignore transient network/abort errors during background polling
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (authState === "authenticated" && activeWorkspaceId) {
      loadWorkspaceData();
      loadTemplates();
    }
  }, [authState, activeWorkspaceId, loadWorkspaceData, loadTemplates]);

  useEffect(() => {
    if (!overview?.stats.runningExecutions) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await loadWorkspaceData();
      if (!cancelled) {
        timer = setTimeout(poll, 4000);
      }
    };
    timer = setTimeout(poll, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [overview?.stats.runningExecutions, loadWorkspaceData]);

  async function handleLogout() {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => {});
    setAuthState("unauthenticated");
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspaceId("");
  }

  if (authState === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#09090b] text-sm text-zinc-400">
        Initializing ContentOS...
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <AuthScreen onAuthenticated={loadSession} />;
  }

  const navItems: Array<{ id: NavSection; label: string; icon: React.ElementType; badge?: string }> = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "projects", label: "Projects", icon: FolderKanban },
    { id: "library", label: "Content Library", icon: Film },
    { id: "automation", label: "Automation", icon: Workflow },
    { id: "publishing", label: "Publishing", icon: Send },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="min-h-screen flex bg-[#09090b] text-zinc-100">
      <aside className="w-64 shrink-0 border-r border-zinc-800/90 bg-[#0d0d10] flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2.5 px-5 py-5 border-b border-zinc-800/80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-indigo-400">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <span className="text-sm font-semibold tracking-tight text-zinc-100">ContentOS</span>
              <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                v0.1
              </span>
            </div>
          </div>

          <div className="p-4 border-b border-zinc-800/80">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
              Workspace
            </label>
            <select
              value={activeWorkspaceId}
              onChange={(e) => {
                setActiveWorkspaceId(e.target.value);
                setSelectedProjectId(null);
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-2 text-xs font-medium text-zinc-200 focus:border-indigo-500 focus:outline-none"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.role})
                </option>
              ))}
            </select>
          </div>

          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeNav === item.id && !selectedProjectId;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveNav(item.id);
                    setSelectedProjectId(null);
                  }}
                  className={
                    "w-full flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition " +
                    (active
                      ? "bg-indigo-600/15 text-indigo-300 border border-indigo-500/20"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200")
                  }
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </span>
                  {item.badge && (
                    <span className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="border-t border-zinc-800/80 p-4 flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-zinc-200">{user?.name}</p>
            <p className="truncate text-[11px] text-zinc-500">{user?.email}</p>
          </div>
          <button
            onClick={handleLogout}
            title="Sign out"
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-6xl space-y-8">
          {selectedProjectId ? (
            <ProjectDetailView
              workspaceId={activeWorkspaceId}
              projectId={selectedProjectId}
              onBack={() => {
                setSelectedProjectId(null);
                loadWorkspaceData();
              }}
              onEdit={(proj) => {
                setEditingProject(proj);
                setModalOpen(true);
              }}
              onDeleted={() => {
                setSelectedProjectId(null);
                loadWorkspaceData();
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight text-zinc-100 capitalize">
                    {activeNav === "overview" ? "Workspace Overview" : activeNav}
                  </h1>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Centralized multi-channel operations & workflow automation
                  </p>
                </div>
                <button
                  onClick={() => {
                    setEditingProject(null);
                    setModalOpen(true);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition shadow-lg shadow-indigo-600/20"
                >
                  <Plus className="h-4 w-4" /> Create Project
                </button>
              </div>

              {(activeNav === "overview" || activeNav === "projects") && (
                <>
                  {activeNav === "overview" && overview && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
                        <div className="flex items-center justify-between text-zinc-400 mb-2">
                          <span className="text-xs">Active Channels</span>
                          <FolderKanban className="h-4 w-4 text-indigo-400" />
                        </div>
                        <p className="text-2xl font-semibold text-zinc-100">
                          {overview.stats.activeProjects}{" "}
                          <span className="text-xs font-normal text-zinc-500">
                            / {overview.stats.totalProjects} total
                          </span>
                        </p>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
                        <div className="flex items-center justify-between text-zinc-400 mb-2">
                          <span className="text-xs">Pipeline Runs</span>
                          <Activity className="h-4 w-4 text-sky-400" />
                        </div>
                        <p className="text-2xl font-semibold text-zinc-100">
                          {overview.stats.totalExecutions}
                        </p>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
                        <div className="flex items-center justify-between text-zinc-400 mb-2">
                          <span className="text-xs">Completed Runs</span>
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        </div>
                        <p className="text-2xl font-semibold text-zinc-100">
                          {overview.stats.completedExecutions}
                        </p>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5">
                        <div className="flex items-center justify-between text-zinc-400 mb-2">
                          <span className="text-xs">Active / Failed</span>
                          <AlertCircle className="h-4 w-4 text-amber-400" />
                        </div>
                        <p className="text-2xl font-semibold text-zinc-100">
                          {overview.stats.runningExecutions}{" "}
                          <span className="text-xs font-normal text-zinc-500">running</span> /{" "}
                          <span className="text-rose-400">{overview.stats.failedExecutions}</span>{" "}
                          <span className="text-xs font-normal text-zinc-500">failed</span>
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-sm font-semibold text-zinc-100">Channel Projects</h2>
                      <span className="text-xs text-zinc-500">
                        Click a project to inspect workflow stages & run jobs
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {(overview?.projects ?? []).map((project) => (
                        <div
                          key={project.id}
                          onClick={() => setSelectedProjectId(project.id)}
                          className="cursor-pointer rounded-xl border border-zinc-800/90 bg-zinc-950/60 p-5 hover:border-indigo-500/50 transition space-y-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <h3 className="text-sm font-semibold text-zinc-100">{project.name}</h3>
                              <p className="text-xs text-indigo-400">{project.niche}</p>
                            </div>
                            <StatusBadge status={project.status} />
                          </div>
                          <p className="text-xs text-zinc-400 line-clamp-2">
                            {project.description || "No description provided."}
                          </p>
                          <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 text-[11px] text-zinc-500">
                            <span className="capitalize">{project.platforms.join(" ? ")}</span>
                            <span>{project._count?.executions ?? 0} runs</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {activeNav === "overview" && (
                    <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6">
                      <h2 className="text-sm font-semibold text-zinc-100 mb-4">
                        Recent Workflow Executions
                      </h2>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-zinc-800 text-zinc-500">
                              <th className="pb-2.5 font-medium">Project</th>
                              <th className="pb-2.5 font-medium">Workflow</th>
                              <th className="pb-2.5 font-medium">Progress</th>
                              <th className="pb-2.5 font-medium">Status</th>
                              <th className="pb-2.5 font-medium">Started</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/60">
                            {(overview?.recentExecutions ?? []).map((exec) => {
                              const completed = exec.stages.filter(
                                (s) => s.status === "COMPLETED"
                              ).length;
                              return (
                                <tr
                                  key={exec.id}
                                  onClick={() => setSelectedProjectId(exec.projectId)}
                                  className="cursor-pointer hover:bg-zinc-900/50"
                                >
                                  <td className="py-3 font-medium text-zinc-200">
                                    {exec.project?.name}
                                  </td>
                                  <td className="py-3 text-zinc-400">
                                    {exec.workflowTemplate?.name}
                                  </td>
                                  <td className="py-3 text-zinc-400">
                                    {completed} / {exec.stages.length} stages
                                  </td>
                                  <td className="py-3">
                                    <StatusBadge status={exec.status} />
                                  </td>
                                  <td className="py-3 text-zinc-500">
                                    {new Date(exec.createdAt).toLocaleString()}
                                  </td>
                                </tr>
                              );
                            })}
                            {(!overview?.recentExecutions ||
                              overview.recentExecutions.length === 0) && (
                              <tr>
                                <td colSpan={5} className="py-6 text-center text-zinc-500">
                                  No workflow executions yet. Open any active project to trigger a run.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}

              {activeNav === "automation" && (
                <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6 space-y-4">
                  <h2 className="text-sm font-semibold text-zinc-100">
                    Registered Workflow Templates
                  </h2>
                  {templates.map((tpl) => (
                    <div
                      key={tpl.id}
                      className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-100">{tpl.name}</h3>
                          <p className="text-xs text-zinc-400">{tpl.description}</p>
                        </div>
                        <span className="rounded bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-1 text-xs text-indigo-300">
                          v{tpl.version} ? {tpl.stages.length} stages
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2 pt-2">
                        {tpl.stages.map((s) => (
                          <span
                            key={s.key}
                            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300"
                          >
                            <Play className="h-3 w-3 text-indigo-400" />
                            {s.order + 1}. {s.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeNav === "library" && (
                <ContentLibraryView workspaceId={activeWorkspaceId} />
              )}

              {activeNav === "publishing" && (
                <PublishingView workspaceId={activeWorkspaceId} />
              )}

              {activeNav === "analytics" && (
                <AnalyticsView workspaceId={activeWorkspaceId} />
              )}

              {activeNav === "settings" && (
                <div className="rounded-xl border border-zinc-800 bg-[#111114] p-6 space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-100">Workspace & Governance Settings</h2>
                  <p className="text-xs text-zinc-400">
                    Active Workspace ID: <span className="font-mono text-zinc-200">{activeWorkspaceId}</span> ? Role-based access control (OWNER / ADMIN / EDITOR / VIEWER) and transactional outbox workers are active.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {modalOpen && (
        <ProjectModal
          workspaceId={activeWorkspaceId}
          templates={templates}
          initialProject={editingProject}
          onClose={() => {
            setModalOpen(false);
            setEditingProject(null);
          }}
          onSaved={loadWorkspaceData}
        />
      )}
    </div>
  );
}
