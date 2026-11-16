"use client";
import React, { useState } from "react";
import { Layers } from "lucide-react";
import { apiFetch } from "@/lib/api";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("founder@contentos.dev");
  const [password, setPassword] = useState("ContentOS2026!");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      } else {
        await apiFetch("/auth/register", {
          method: "POST",
          body: JSON.stringify({ name, email, password, workspaceName: workspaceName || undefined }),
        });
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090b] px-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#111114] p-8 shadow-2xl">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-indigo-400">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-100">ContentOS</h1>
            <p className="text-xs text-zinc-500">Multi-Channel Content Operations Engine</p>
          </div>
        </div>
        <div className="grid grid-cols-2 rounded-lg bg-zinc-950 p-1 border border-zinc-800/80 mb-6">
          <button type="button" onClick={() => setMode("login")} className={"rounded-md py-1.5 text-xs font-medium transition " + (mode === "login" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}>Sign In</button>
          <button type="button" onClick={() => setMode("register")} className={"rounded-md py-1.5 text-xs font-medium transition " + (mode === "register" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}>Create Account</button>
        </div>
        {error && <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "register" && (
            <>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Full Name</label>
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Satyajit Swain" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">Workspace Name (Optional)</label>
                <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Checkpoint Media Group" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Password</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none" />
          </div>
          <button type="submit" disabled={loading} className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition">
            {loading ? "Authenticating..." : mode === "login" ? "Sign In to Workspace" : "Create Workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
