"use client";

import React, { useEffect, useState, useCallback } from "react";
import { UserPlus, Sparkles, Video, Image as ImageIcon, Play, Download, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface CharacterProfile {
  id: string;
  workspaceId: string;
  name: string;
  tagline: string;
  seed: number;
  appearance: {
    ageRange: string;
    ethnicity: string;
    faceShape: string;
    eyeColor: string;
    hairStyle: string;
    hairColor: string;
    skinTone: string;
  };
  wardrobe: {
    primaryOutfit: string;
    casualOutfit: string;
    formalOutfit: string;
    accentColor: string;
  };
  styleAnchor: string;
  createdAt: string;
}

interface GeneratedShot {
  shotId: string;
  preset: string;
  poseLabel: string;
  sceneryLabel: string;
  positivePrompt: string;
  imageUrl: string;
  createdAt: string;
}

interface GeneratedVideo {
  videoId: string;
  title: string;
  voice: string;
  script: string;
  videoUrl: string;
  durationSec: number;
  createdAt: string;
}

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/v1$/, "") || "http://localhost:4000";

export function FemaleLibraryView({ workspaceId }: { workspaceId: string }) {
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeChar, setActiveChar] = useState<CharacterProfile | null>(null);
  const [shots, setShots] = useState<GeneratedShot[]>([]);
  const [videos, setVideos] = useState<GeneratedVideo[]>([]);
  const [creatingChar, setCreatingChar] = useState(false);
  const [busyShot, setBusyShot] = useState(false);
  const [busyVideo, setBusyVideo] = useState(false);

  // New Character Form State
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [ageRange, setAgeRange] = useState("24-year-old");
  const [ethnicity, setEthnicity] = useState("South Asian");
  const [faceShape, setFaceShape] = useState("oval with soft defined jawline");
  const [eyeColor, setEyeColor] = useState("warm amber-brown");
  const [hairStyle, setHairStyle] = useState("shoulder-length layered waves");
  const [hairColor, setHairColor] = useState("jet black");
  const [skinTone, setSkinTone] = useState("warm olive");
  const [primaryOutfit, setPrimaryOutfit] = useState("tailored charcoal blazer over ivory silk top");

  // Shot & Video Controls
  const [preset, setPreset] = useState("editorial_portrait");
  const [pose, setPose] = useState("");
  const [scenery, setScenery] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [videoVoice, setVideoVoice] = useState("en-US-AriaNeural");
  const [videoScript, setVideoScript] = useState("");

  const loadCharacters = useCallback(async () => {
    if (!workspaceId) return;
    const res = await apiFetch<{ characters: CharacterProfile[] }>(
      `/workspaces/${workspaceId}/female-library`
    );
    setCharacters(res.characters);
    if (!selectedId && res.characters[0]) {
      setSelectedId(res.characters[0].id);
    }
  }, [workspaceId, selectedId]);

  const loadCharacterDetail = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    const res = await apiFetch<{
      character: CharacterProfile;
      shots: GeneratedShot[];
      videos: GeneratedVideo[];
    }>(`/workspaces/${workspaceId}/female-library/${selectedId}`);
    setActiveChar(res.character);
    setShots(res.shots);
    setVideos(res.videos);
  }, [workspaceId, selectedId]);

  useEffect(() => {
    loadCharacters();
  }, [loadCharacters]);

  useEffect(() => {
    loadCharacterDetail();
  }, [loadCharacterDetail]);

  async function handleCreateCharacter(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await apiFetch<{ character: CharacterProfile }>(
      `/workspaces/${workspaceId}/female-library`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          tagline,
          ageRange,
          ethnicity,
          faceShape,
          eyeColor,
          hairStyle,
          hairColor,
          skinTone,
          primaryOutfit,
        }),
      }
    );
    setName("");
    setTagline("");
    setCreatingChar(false);
    setSelectedId(res.character.id);
    await loadCharacters();
  }

  async function handleGenerateShot(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setBusyShot(true);
    try {
      await apiFetch(`/workspaces/${workspaceId}/female-library/${selectedId}/shots`, {
        method: "POST",
        body: JSON.stringify({ preset, pose, scenery }),
      });
      setPose("");
      setScenery("");
      await loadCharacterDetail();
    } finally {
      setBusyShot(false);
    }
  }

  async function handleGenerateVideo(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !videoScript.trim()) return;
    setBusyVideo(true);
    try {
      await apiFetch(`/workspaces/${workspaceId}/female-library/${selectedId}/videos`, {
        method: "POST",
        body: JSON.stringify({
          title: videoTitle || `${activeChar?.name ?? "Character"} Lookbook Reel`,
          voice: videoVoice,
          script: videoScript,
        }),
      });
      setVideoTitle("");
      setVideoScript("");
      await loadCharacterDetail();
    } finally {
      setBusyVideo(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-[#111114] p-5">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Female Library ? Consistent Character Studio</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Create isolated fictional female personas with locked facial traits & seeds, generate multi-pose/scenery frames, and render narrated 9:16 videos.
          </p>
        </div>
        <button
          onClick={() => setCreatingChar((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition"
        >
          <UserPlus className="h-4 w-4" />
          {creatingChar ? "Close Form" : "New Character"}
        </button>
      </div>

      {creatingChar && (
        <form
          onSubmit={handleCreateCharacter}
          className="rounded-xl border border-indigo-500/30 bg-[#111114] p-5 space-y-4 text-xs"
        >
          <h3 className="text-sm font-semibold text-zinc-100">Create Consistent Fictional Character</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Character Name (e.g. Aria Vance)"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Role / Niche (e.g. Lifestyle Host)"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={ageRange}
              onChange={(e) => setAgeRange(e.target.value)}
              placeholder="Age Range (e.g. 24-year-old)"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={ethnicity}
              onChange={(e) => setEthnicity(e.target.value)}
              placeholder="Ethnicity"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={faceShape}
              onChange={(e) => setFaceShape(e.target.value)}
              placeholder="Face Shape"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={eyeColor}
              onChange={(e) => setEyeColor(e.target.value)}
              placeholder="Eye Color"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={hairStyle}
              onChange={(e) => setHairStyle(e.target.value)}
              placeholder="Hair Style"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={hairColor}
              onChange={(e) => setHairColor(e.target.value)}
              placeholder="Hair Color"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
            <input
              value={skinTone}
              onChange={(e) => setSkinTone(e.target.value)}
              placeholder="Skin Tone"
              className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
          </div>
          <input
            value={primaryOutfit}
            onChange={(e) => setPrimaryOutfit(e.target.value)}
            placeholder="Signature Wardrobe Outfit"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Save Character Profile
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 space-y-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Saved Characters ({characters.length})
          </p>
          {characters.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5 text-xs text-zinc-400">
              No characters yet. Click <strong>New Character</strong> above to create your first consistent persona.
            </div>
          ) : (
            characters.map((ch) => (
              <button
                key={ch.id}
                onClick={() => setSelectedId(ch.id)}
                className={
                  "w-full text-left rounded-xl border p-4 transition " +
                  (selectedId === ch.id
                    ? "border-indigo-500 bg-indigo-600/10"
                    : "border-zinc-800 bg-[#111114] hover:border-zinc-700")
                }
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-100">{ch.name}</span>
                  <span className="font-mono text-[10px] text-amber-400 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">
                    Seed #{ch.seed}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-1">{ch.tagline}</p>
                <p className="text-[11px] text-zinc-500 mt-1">
                  {ch.appearance.ageRange} ? {ch.appearance.ethnicity} ? {ch.appearance.hairStyle}
                </p>
              </button>
            ))
          )}
        </div>

        <div className="lg:col-span-8 space-y-6">
          {activeChar ? (
            <>
              <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">{activeChar.name}</h3>
                    <p className="text-xs text-zinc-400">
                      {activeChar.appearance.faceShape} ? {activeChar.appearance.eyeColor} eyes ? {activeChar.appearance.skinTone} skin
                    </p>
                  </div>
                  <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2.5 py-1 rounded">
                    IDENTITY LOCKED ? SEED {activeChar.seed}
                  </span>
                </div>

                <form onSubmit={handleGenerateShot} className="space-y-3 text-xs">
                  <div className="flex items-center gap-2 text-zinc-300 font-medium">
                    <ImageIcon className="h-4 w-4 text-indigo-400" />
                    Generate Pose & Scenery Frame
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <select
                      value={preset}
                      onChange={(e) => setPreset(e.target.value)}
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
                    >
                      <option value="editorial_portrait">Editorial Portrait</option>
                      <option value="streetwear_lifestyle">Streetwear Lifestyle</option>
                      <option value="studio_fashion">Studio Fashion Lookbook</option>
                      <option value="turnaround_sheet">3-Angle Turnaround</option>
                      <option value="fitness_athletic">Fitness & Wellness</option>
                      <option value="cinematic_closeup">Cinematic Close-Up</option>
                    </select>
                    <input
                      value={pose}
                      onChange={(e) => setPose(e.target.value)}
                      placeholder="Custom pose (optional)"
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
                    />
                    <input
                      value={scenery}
                      onChange={(e) => setScenery(e.target.value)}
                      placeholder="Custom scenery (optional)"
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busyShot}
                    className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {busyShot ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {busyShot ? "Rendering Frame..." : "Generate Pose & Scenery Image"}
                  </button>
                </form>

                <form onSubmit={handleGenerateVideo} className="space-y-3 text-xs border-t border-zinc-800 pt-4">
                  <div className="flex items-center gap-2 text-zinc-300 font-medium">
                    <Video className="h-4 w-4 text-emerald-400" />
                    Create Video with Audio (Multi-Pose + EdgeTTS Voiceover)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <input
                      value={videoTitle}
                      onChange={(e) => setVideoTitle(e.target.value)}
                      placeholder="Video Title (e.g. Morning Routine in Tokyo)"
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
                    />
                    <select
                      value={videoVoice}
                      onChange={(e) => setVideoVoice(e.target.value)}
                      className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
                    >
                      <option value="en-US-AriaNeural">Aria Neural (Expressive Female)</option>
                      <option value="en-US-JennyNeural">Jenny Neural (Warm Conversational)</option>
                      <option value="en-GB-SoniaNeural">Sonia Neural (British Editorial)</option>
                      <option value="en-IN-NeerjaNeural">Neerja Neural (Indian English)</option>
                <option value="hi-IN-MadhurNeural">Madhur Neural (Hindi Male)</option>
                <option value="hi-IN-SwaraNeural">Swara Neural (Hindi Female)</option>
                <option value="hi-IN-MadhurNeural:energetic">Kabir Neural (Hindi Energetic Male)</option>
                <option value="hi-IN-SwaraNeural:calm">Kavya Neural (Hindi Calm Female)</option>
                    </select>
                  </div>
                  <textarea
                    required
                    rows={3}
                    value={videoScript}
                    onChange={(e) => setVideoScript(e.target.value)}
                    placeholder="Write the voiceover narration script for this character reel..."
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200"
                  />
                  <button
                    type="submit"
                    disabled={busyVideo}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {busyVideo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {busyVideo ? "Rendering Narrated Video..." : "Create Video with Audio"}
                  </button>
                </form>
              </div>

              {videos.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5 space-y-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Rendered Character Videos ({videos.length})
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {videos.map((v) => (
                      <div key={v.videoId} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 space-y-2">
                        <video
                          controls
                          src={`${API_ORIGIN}${v.videoUrl}`}
                          className="w-full aspect-[9/16] max-h-80 rounded-lg bg-black object-contain"
                        />
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-zinc-200 truncate">{v.title}</span>
                          <a
                            href={`${API_ORIGIN}${v.videoUrl}`}
                            download
                            className="inline-flex items-center gap-1 text-indigo-400 hover:underline"
                          >
                            <Download className="h-3.5 w-3.5" /> MP4
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {shots.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-[#111114] p-5 space-y-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Pose & Scenery Frames ({shots.length})
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {shots.map((sh) => (
                      <div key={sh.shotId} className="rounded-xl border border-zinc-800 bg-zinc-950 p-2.5 space-y-2">
                        <img
                          src={`${API_ORIGIN}${sh.imageUrl}`}
                          alt={sh.preset}
                          className="w-full aspect-[9/16] max-h-64 rounded-lg object-cover"
                        />
                        <div className="text-[11px] font-semibold text-indigo-400 uppercase">{sh.preset.replace("_", " ")}</div>
                        <p className="text-[11px] text-zinc-400 line-clamp-2">{sh.sceneryLabel}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-[#111114] p-8 text-center text-xs text-zinc-400">
              Select or create a character profile to generate pose & scenery images and narrated videos.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
