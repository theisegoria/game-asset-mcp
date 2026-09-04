import type { ToolContext } from '../tools/context.js';
import { registerWorkflowTools } from '../tools/workflows.js';
import { registerReferenceTools } from '../tools/references.js';
import { registerAsset3DTools } from '../tools/assets3d.js';
import { registerTextureTools } from '../tools/textures.js';
import { registerJobTools } from '../tools/jobs.js';
import { registerDownloadTools } from '../tools/downloads.js';
import { registerInspectionTools } from '../tools/inspection.js';
import { registerPbrTools } from '../tools/pbr.js';
import { registerAudioTools } from '../tools/audio.js';
import { registerNormalizeTools } from '../tools/normalize.js';
import { registerSpendTools } from '../tools/spend.js';
import { registerValidateTools } from '../tools/validate.js';
import { registerAnimationTools } from '../tools/animation.js';
import { registerBatchTools } from '../tools/batch.js';
import { registerHarnessTools } from '../tools/harness.js';
import { registerContactSheetTools } from '../tools/contact-sheet.js';
import type { ToolRegistrar } from './registry.js';

export function registerAssetCommands(registry: ToolRegistrar, ctx: ToolContext): void {
  registerWorkflowTools(registry, ctx);
  registerReferenceTools(registry, ctx);
  registerAsset3DTools(registry, ctx);
  registerTextureTools(registry, ctx);
  registerJobTools(registry, ctx);
  registerDownloadTools(registry, ctx);
  registerInspectionTools(registry, ctx);
  registerPbrTools(registry, ctx);
  registerAudioTools(registry, ctx);
  registerNormalizeTools(registry, ctx);
  registerSpendTools(registry, ctx);
  registerValidateTools(registry, ctx);
  registerAnimationTools(registry, ctx);
  registerBatchTools(registry, ctx);
  registerHarnessTools(registry, ctx);
  registerContactSheetTools(registry, ctx);
}
