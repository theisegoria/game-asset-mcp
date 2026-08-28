export interface MacOSRuntimeProvenanceBindingInput {
  runtimeRoster: unknown;
  runtimePackage: unknown;
  provenance: unknown;
  nodeVersion: string;
}

export interface MacOSRuntimeProvenanceVerification {
  gameDevCliVersion: string;
  nodeVersion: string;
  nonSystemDylibCount: number;
  ok: true;
  schema: 'game_dev.macos_runtime_third_party_provenance_verification.v1';
}

export function validateMacOSRuntimeProvenanceBinding(
  input: MacOSRuntimeProvenanceBindingInput,
): MacOSRuntimeProvenanceVerification;
