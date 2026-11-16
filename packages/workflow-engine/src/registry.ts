import type { StageKey } from "@contentos/shared";
import type { WorkflowStageHandler } from "./types.js";
import {
  ResearchStageHandler,
  ScriptGenerationStageHandler,
  AssetPreparationStageHandler,
  MediaProductionStageHandler,
  VideoRenderingStageHandler,
  QualityControlStageHandler,
  ApprovalGateStageHandler,
  PublishingPreparationStageHandler,
} from "./handlers/simulatedHandlers.js";

export class StageRegistry {
  private readonly handlers = new Map<StageKey, WorkflowStageHandler>();

  register(handler: WorkflowStageHandler): this {
    this.handlers.set(handler.key, handler);
    return this;
  }

  get(key: StageKey): WorkflowStageHandler {
    const handler = this.handlers.get(key);
    if (!handler) {
      throw new Error("No workflow stage handler registered for key: " + key);
    }
    return handler;
  }
}

export const defaultStageRegistry = new StageRegistry()
  .register(new ResearchStageHandler())
  .register(new ScriptGenerationStageHandler())
  .register(new AssetPreparationStageHandler())
  .register(new MediaProductionStageHandler())
  .register(new VideoRenderingStageHandler())
  .register(new QualityControlStageHandler())
  .register(new ApprovalGateStageHandler())
  .register(new PublishingPreparationStageHandler());
