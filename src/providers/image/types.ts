/**
 * The image-provider contract.
 *
 * Reference images exist to be reconstructed into geometry, so this interface
 * cares about things a concept-art tool would not bother returning: the seed
 * (for reproducibility), the exact dimensions, and stable per-image ids so a
 * variation can name its parent.
 */

export interface GeneratedImage {
  /** Provider's id for this specific image. */
  providerImageId?: string;
  url: string;
  seed?: number;
  width?: number;
  height?: number;
}

export interface ImageGenerationHandle {
  providerGenerationId: string;
  rawStatus?: string;
}

export interface ImageGenerationResult {
  providerGenerationId: string;
  rawStatus: string;
  images: GeneratedImage[];
  errorMessage?: string;
  raw: unknown;
}

export interface GenerateImageOptions {
  prompt: string;
  negativePrompt?: string;
  /** Provider model identifier. Defaults to the provider's recommended model. */
  modelId?: string;
  width?: number;
  height?: number;
  numImages?: number;
  seed?: number;
  guidanceScale?: number;
  /** Condition on an existing image the provider already holds. */
  initImageId?: string;
  initStrength?: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly defaultModelId: string;

  generate(options: GenerateImageOptions): Promise<ImageGenerationHandle>;
  getGeneration(providerGenerationId: string): Promise<ImageGenerationResult>;
}
