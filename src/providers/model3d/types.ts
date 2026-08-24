/**
 * The 3D-provider contract.
 *
 * Kept deliberately small. The point is not to abstract over every capability
 * any vendor might ever ship — it is to ensure the MCP tool surface does not
 * change when a second provider is added. Anything vendor-specific travels in
 * `raw` rather than being promoted into this interface.
 */

export interface Model3DTaskHandle {
  providerTaskId: string;
  /** Provider's own status string, unmapped. */
  rawStatus?: string;
}

export interface Model3DTaskResult {
  providerTaskId: string;
  /** Provider's own status string. Callers map it; we do not lose it. */
  rawStatus: string;
  /** Present once the task succeeds. These URLs commonly EXPIRE. */
  modelUrl?: string;
  pbrModelUrl?: string;
  renderedImageUrl?: string;
  /** 0..100 when the provider reports it. */
  progress?: number;
  creditCost?: number;
  errorMessage?: string;
  raw: unknown;
}

export interface GenerateFromImageOptions {
  /** A provider file token from `uploadImage`, or an https URL. Exactly one. */
  imageToken?: string;
  imageUrl?: string;
  modelVersion?: string;
  pbr?: boolean;
  texture?: boolean;
  textureQuality?: 'standard' | 'detailed';
  faceLimit?: number;
  quad?: boolean;
  seed?: number;
  autoSize?: boolean;
  /** Let the provider correct a poor reference image before reconstruction. */
  imageAutofix?: boolean;
}

export interface GenerateFromTextOptions {
  prompt: string;
  negativePrompt?: string;
  modelVersion?: string;
  pbr?: boolean;
  texture?: boolean;
  textureQuality?: 'standard' | 'detailed';
  faceLimit?: number;
  quad?: boolean;
  seed?: number;
}

export interface TextureExistingOptions {
  /**
   * A prior provider task whose model output should be retextured.
   * Mutually exclusive with `modelToken`.
   */
  originalModelTaskId?: string;
  /** A file token from `uploadModel`, for a mesh the user already owns. */
  modelToken?: string;
  /** Text direction for the material. Mutually exclusive with `imageToken`. */
  prompt?: string;
  imageToken?: string;
  styleImageToken?: string;
  modelVersion?: string;
  pbr?: boolean;
  textureQuality?: 'standard' | 'detailed';
  textureAlignment?: 'original_image' | 'geometry';
  textureSeed?: number;
  bake?: boolean;
}

export interface Model3DProvider {
  readonly name: string;

  /** Upload an image, returning a provider file token. */
  uploadImage(bytes: Uint8Array, fileName: string): Promise<string>;

  /** Upload a mesh (GLB/GLTF/FBX/OBJ/STL), returning a provider file token. */
  uploadModel(bytes: Uint8Array, fileName: string): Promise<string>;

  generateFromImage(options: GenerateFromImageOptions): Promise<Model3DTaskHandle>;
  generateFromText(options: GenerateFromTextOptions): Promise<Model3DTaskHandle>;

  /** Apply new textures to an existing mesh. */
  textureExisting(options: TextureExistingOptions): Promise<Model3DTaskHandle>;

  getTask(providerTaskId: string): Promise<Model3DTaskResult>;
}
