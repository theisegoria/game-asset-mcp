/**
 * The AssetJob — the unit of identity and provenance in this server.
 *
 * Two rules drive the shape:
 *
 *   1. OUR id is the identity. Provider task ids are metadata. A provider can
 *      expire a task, change its id scheme, or be swapped for a competitor;
 *      none of that may invalidate the local record of what we asked for and
 *      what we got back.
 *
 *   2. Provenance is recorded at the moment it is known, not reconstructed
 *      later. Which prompt produced this? Which seed? Which model version?
 *      Those answers are unrecoverable once the provider's task ages out, so
 *      they are written into the job as it progresses.
 */

import { randomUUID } from 'node:crypto';
import type { AssetJobStatus } from './status.js';
import type { GameAssetSpec } from './asset-spec.js';

export interface ReferenceCandidate {
  /** Stable local id, unique within the job. */
  id: string;
  /** Remote URL as returned by the image provider. May expire. */
  url: string;
  /** Local path once downloaded, if it has been. */
  localPath?: string;
  seed?: number;
  width?: number;
  height?: number;
  /** Provider's own id for this image, kept for support/debugging. */
  providerImageId?: string;
  /** Id of the candidate this was varied from, if any. */
  parentCandidateId?: string;
}

export interface ImageGenerationRecord {
  provider: string;
  model?: string;
  modelId?: string;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  /** Provider's generation id, for support queries. */
  providerGenerationId?: string;
  requestedAt: string;
  metadata?: Record<string, unknown>;
}

export interface Model3DGenerationRecord {
  provider: string;
  /** Provider model version string, e.g. a dated version tag. */
  modelVersion?: string;
  providerTaskId?: string;
  /** The task type asked for, e.g. image_to_model / text_to_model / texture_model. */
  taskType: string;
  parameters: Record<string, unknown>;
  requestedAt: string;
  /** Remote URLs the provider returned. These commonly EXPIRE — download promptly. */
  modelUrl?: string;
  pbrModelUrl?: string;
  renderedImageUrl?: string;
  /** Credits consumed, when the provider reports it. */
  creditCost?: number;
  metadata?: Record<string, unknown>;
}

export interface DownloadedFile {
  path: string;
  bytes: number;
  sha256: string;
  contentType?: string;
  /** What this file is, for callers that do not want to guess from extension. */
  kind: 'model' | 'texture' | 'reference' | 'preview' | 'metadata';
}

export interface AssetJob {
  /** Local stable identity: `asset_<uuid>`. */
  id: string;
  schemaVersion: 1;
  name: string;
  /** Sanitized folder name in the workspace. */
  slug: string;
  status: AssetJobStatus;
  /** The provider's own status string, unmapped. */
  providerStatus?: string;

  /** The original request, verbatim. */
  spec: GameAssetSpec;
  /** Free-text of what the user asked for, when it came in as prose. */
  userRequest?: string;

  image?: ImageGenerationRecord;
  candidates: ReferenceCandidate[];
  selectedCandidateId?: string;

  model3d?: Model3DGenerationRecord;

  files: DownloadedFile[];
  /** Directory holding this asset's workspace, relative to the output root. */
  workspacePath?: string;

  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };

  /** Parent job when this one was produced as a variation. */
  parentJobId?: string;
}

export function newAssetJobId(): string {
  return `asset_${randomUUID()}`;
}

export function createAssetJob(params: {
  spec: GameAssetSpec;
  slug: string;
  userRequest?: string;
  parentJobId?: string;
  now?: string;
}): AssetJob {
  const timestamp = params.now ?? new Date().toISOString();
  return {
    id: newAssetJobId(),
    schemaVersion: 1,
    name: params.spec.name,
    slug: params.slug,
    status: 'queued',
    spec: params.spec,
    ...(params.userRequest !== undefined ? { userRequest: params.userRequest } : {}),
    ...(params.parentJobId !== undefined ? { parentJobId: params.parentJobId } : {}),
    candidates: [],
    files: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * A compact view for tool responses.
 *
 * Full jobs carry prompts, parameter blobs and file lists that would flood an
 * agent's context on every poll. Tools return this unless asked for detail.
 */
export interface AssetJobSummary {
  assetJobId: string;
  name: string;
  status: AssetJobStatus;
  providerStatus?: string;
  provider?: string;
  providerTaskId?: string;
  candidateCount: number;
  selectedCandidateId?: string;
  fileCount: number;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}

export function summarizeAssetJob(job: AssetJob): AssetJobSummary {
  return {
    assetJobId: job.id,
    name: job.name,
    status: job.status,
    ...(job.providerStatus !== undefined ? { providerStatus: job.providerStatus } : {}),
    ...(job.model3d?.provider !== undefined
      ? { provider: job.model3d.provider }
      : job.image?.provider !== undefined
        ? { provider: job.image.provider }
        : {}),
    ...(job.model3d?.providerTaskId !== undefined
      ? { providerTaskId: job.model3d.providerTaskId }
      : {}),
    candidateCount: job.candidates.length,
    ...(job.selectedCandidateId !== undefined
      ? { selectedCandidateId: job.selectedCandidateId }
      : {}),
    fileCount: job.files.length,
    ...(job.workspacePath !== undefined ? { workspacePath: job.workspacePath } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.error !== undefined
      ? { error: { code: job.error.code, message: job.error.message } }
      : {}),
  };
}
