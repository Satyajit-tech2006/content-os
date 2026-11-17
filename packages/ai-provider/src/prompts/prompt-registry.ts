import { z } from "zod";
import type { AITaskType } from "../types.js";

export const StoryboardBeatSchema = z.object({
  beatSummary: z.string().min(2).max(80),
  action: z
    .enum([
      "thinking",
      "walking_across",
      "presenting_board",
      "directing_swarm",
      "juggling_tasks",
      "examining_lens",
      "celebrating",
    ])
    .default("presenting_board"),
  position: z.enum(["left", "center", "right", "traverse"]).default("left"),
  propType: z
    .enum([
      "comparison_bars",
      "parallel_grid",
      "flow_network",
      "growth_chart",
      "blueprint_structure",
      "speed_gauge",
      "magnifying_lens",
      "trophy_badge",
    ])
    .default("growth_chart"),
  propTitle: z.string().min(2).max(36),
  propMetrics: z.array(z.string().min(1).max(28)).min(1).max(4).default(["STEP 1", "STEP 2"]),
});

export type StoryboardBeat = z.infer<typeof StoryboardBeatSchema>;

export const GeneratedScriptSchema = z.object({
  title: z.string().min(3).max(160),
  hook: z.string().min(5).max(320),
  script: z.string().min(20),
  description: z.string().min(5).max(1000),
  hashtags: z.array(z.string().min(1)).min(1).max(15),
  estimatedDuration: z.number().int().min(5).max(600),
  storyboard: z.array(StoryboardBeatSchema).min(2).max(8).optional(),
});

export type ValidatedScriptOutput = z.infer<typeof GeneratedScriptSchema>;

export const ContentIdeasSchema = z.object({
  topic: z.string().min(2),
  angle: z.string().min(5),
  hookIdeas: z.array(z.string().min(5)).min(1).max(5),
  talkingPoints: z.array(z.string().min(5)).min(1).max(6),
  targetKeywords: z.array(z.string().min(1)).min(1).max(8),
});

export type ValidatedContentIdeasOutput = z.infer<typeof ContentIdeasSchema>;

export const ClassificationSchema = z.object({
  category: z.string().min(1),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
});

export const SummarizationSchema = z.object({
  summary: z.string().min(10),
  bulletPoints: z.array(z.string().min(3)).min(1).max(6),
});

export interface PromptDefinition<T = unknown> {
  id: string;
  version: string;
  description: string;
  task: AITaskType;
  active: boolean;
  systemPrompt: string;
  renderTemplate: (vars: Record<string, unknown>) => string;
  outputSchema: z.ZodType<T>;
}

export class PromptRegistry {
  private readonly prompts = new Map<string, PromptDefinition<any>>();

  constructor() {
    this.registerDefaults();
  }

  register<T>(def: PromptDefinition<T>): void {
    this.prompts.set(def.id + "@" + def.version, def);
    if (def.active) {
      this.prompts.set(def.id, def);
    }
  }

  get<T = unknown>(id: string, version?: string): PromptDefinition<T> {
    const key = version ? id + "@" + version : id;
    const found = this.prompts.get(key);
    if (!found) {
      throw new Error("Prompt template not found: " + key);
    }
    if (!found.active && !version) {
      throw new Error("Prompt template '" + id + "' is currently inactive.");
    }
    return found as PromptDefinition<T>;
  }

  list(): Array<Omit<PromptDefinition<unknown>, "renderTemplate" | "outputSchema"> & { hasSchema: boolean }> {
    const seen = new Set<string>();
    const results: Array<Omit<PromptDefinition<unknown>, "renderTemplate" | "outputSchema"> & { hasSchema: boolean }> = [];
    for (const def of this.prompts.values()) {
      const uid = def.id + "@" + def.version;
      if (seen.has(uid)) continue;
      seen.add(uid);
      results.push({
        id: def.id,
        version: def.version,
        description: def.description,
        task: def.task,
        active: def.active,
        systemPrompt: def.systemPrompt,
        hasSchema: true,
      });
    }
    return results;
  }

  private registerDefaults(): void {
    this.register({
      id: "content-ideas-brief",
      version: "1.0.0",
      description: "Generates structured editorial angles, opening hooks, and talking points without fabricating live facts.",
      task: "content_ideas",
      active: true,
      systemPrompt: "You are a senior short-form content strategist. Output ONLY valid JSON matching the requested schema. Do not invent unverified statistics or breaking news dates.",
      renderTemplate: (vars) => [
        "Channel Name: " + String(vars.projectName ?? "Creator Channel"),
        "Niche: " + String(vars.niche ?? "General"),
        "Target Audience: " + String(vars.targetAudience ?? "General viewers"),
        "Topic / Angle Seed: " + String(vars.topic ?? "Trending topic in niche"),
        "Tone: " + String(vars.tone ?? "engaging"),
        "Language: " + String(vars.language ?? "English"),
        "Return strictly a JSON object with keys:",
        "- topic (string)",
        "- angle (string: crisp editorial angle)",
        "- hookIdeas (array of 3 punchy opening hooks)",
        "- talkingPoints (array of 3-4 clear educational/entertaining points)",
        "- targetKeywords (array of 4-6 discovery keywords)"
      ].join("\n"),
      outputSchema: ContentIdeasSchema,
    });

    this.register({
      id: "short-form-script-generator",
      version: "1.0.0",
      description: "Generates a complete short-form video script with hook, narration body, description, hashtags, duration estimate, and dynamic storyboard.",
      task: "script_generation",
      active: true,
      systemPrompt: "You are an elite short-form video scriptwriter and visual director. Output ONLY valid JSON matching the exact schema keys requested. No markdown fences or commentary.",
      renderTemplate: (vars) => [
        "Create a complete video script with the following parameters:",
        "- Channel / Project: " + String(vars.projectName ?? "Creator Channel"),
        "- Topic: " + String(vars.topic ?? "Industry breakdown"),
        "- Target Audience: " + String(vars.targetAudience ?? "General audience"),
        "- Content Platform: " + String(vars.contentPlatform ?? "YouTube Shorts / Instagram Reels"),
        "- Target Duration Range: " + String(vars.durationRange ?? "30-45s") + " (word budget: " + String(vars.wordBudget ?? "75-110 words") + "). Finish every thought cleanly with a complete outro/CTA within this range; NEVER include timestamps like (0s-3s) or [Visual:] cues inside the spoken script.",
        "- Tone: " + String(vars.tone ?? "engaging and clear"),
        "- Language: " + String(vars.language ?? "English"),
        vars.editorialBrief ? "- Editorial Brief Context: " + JSON.stringify(vars.editorialBrief) : "",
        "Return ONLY a JSON object with these exact keys:",
        "{",
        "  \"title\": string,",
        "  \"hook\": string (attention-grabbing first 3 seconds),",
        "  \"script\": string (complete spoken voiceover narration from start to CTA),",
        "  \"description\": string (social post caption/description),",
        "  \"hashtags\": string[] (4-8 relevant hashtags starting with #),",
        "  \"estimatedDuration\": number (integer seconds matching pacing),",
        "  \"storyboard\": [ (3-6 dynamic visual scenes matching each part of the script)",
        "    { \"beatSummary\": string, \"action\": \"thinking\"|\"walking_across\"|\"presenting_board\"|\"directing_swarm\"|\"juggling_tasks\"|\"examining_lens\"|\"celebrating\", \"position\": \"left\"|\"center\"|\"right\"|\"traverse\", \"propType\": \"comparison_bars\"|\"parallel_grid\"|\"flow_network\"|\"growth_chart\"|\"blueprint_structure\"|\"speed_gauge\"|\"magnifying_lens\"|\"trophy_badge\", \"propTitle\": string, \"propMetrics\": string[] }",
        "  ]",
        "}"
      ].filter(Boolean).join("\n"),
      outputSchema: GeneratedScriptSchema,
    });

    this.register({
      id: "content-classification",
      version: "1.0.0",
      description: "Lightweight classification and sentiment tagging for content snippets.",
      task: "classification",
      active: true,
      systemPrompt: "You are a precise content classifier. Return strictly valid JSON.",
      renderTemplate: (vars) => [
        "Classify the following text into category, sentiment (positive|neutral|negative), confidence (0..1), and tags (string[]):",
        String(vars.text ?? "")
      ].join("\n"),
      outputSchema: ClassificationSchema,
    });

    this.register({
      id: "content-summarization",
      version: "1.0.0",
      description: "Lightweight summarization into concise summary + bullet points.",
      task: "summarization",
      active: true,
      systemPrompt: "You are a concise editorial summarizer. Return strictly valid JSON.",
      renderTemplate: (vars) => [
        "Summarize the following content into JSON with keys summary (string) and bulletPoints (string[]):",
        String(vars.text ?? "")
      ].join("\n"),
      outputSchema: SummarizationSchema,
    });
  }
}
