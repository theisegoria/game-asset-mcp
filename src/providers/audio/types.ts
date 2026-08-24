/**
 * The audio-provider contract.
 *
 * Game audio is generated in short, often looping clips — a weapon report, a
 * footstep, a UI blip — so this interface cares about duration and loopability
 * in a way a music or speech API would not.
 */

export interface GeneratedAudio {
  url: string;
  providerAudioId?: string;
  durationSeconds?: number;
  /** Container/codec as reported by the provider, when it says. */
  contentType?: string;
}

export interface AudioGenerationHandle {
  providerGenerationId: string;
  rawStatus?: string;
}

export interface AudioGenerationResult {
  providerGenerationId: string;
  rawStatus: string;
  audio: GeneratedAudio[];
  errorMessage?: string;
  raw: unknown;
}

export interface GenerateSoundEffectOptions {
  prompt: string;
  /** Whole seconds. Providers cap this; the client clamps rather than guessing. */
  durationSeconds?: number;
  /** How strictly to follow the prompt, 0..1. */
  promptInfluence?: number;
  /** Ask for a seamless loop — the difference between usable ambience and not. */
  loop?: boolean;
  /** How many variations to return. Each one costs credits. */
  quantity?: number;
}

export interface AudioProvider {
  readonly name: string;
  readonly defaultModel: string;

  generateSoundEffect(options: GenerateSoundEffectOptions): Promise<AudioGenerationHandle>;
  getGeneration(providerGenerationId: string): Promise<AudioGenerationResult>;
}
