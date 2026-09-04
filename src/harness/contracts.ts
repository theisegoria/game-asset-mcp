import path from 'node:path';
import { z } from 'zod';

export const GAME_DEV_ADAPTER_SCHEMA = 'game_dev.adapter.v1' as const;
export const GAME_DEV_CAPTURE_SCHEMA = 'game_dev.capture.v1' as const;
export const GAME_DEV_RUN_SCHEMA = 'game_dev.run.v1' as const;
export const GAME_DEV_TELEMETRY_SCHEMA = 'game_dev.telemetry_event.v1' as const;
export const GAME_DEV_PERFORMANCE_SUMMARY_SCHEMA = 'game_dev.performance_summary.v1' as const;
export const GAME_DEV_PERFORMANCE_COMPARISON_SCHEMA = 'game_dev.performance_comparison.v1' as const;
export const GAME_DEV_VISUAL_COMPARISON_SCHEMA = 'game_dev.visual_comparison.v1' as const;
export const GAME_DEV_OPTIMIZATION_GOAL_SCHEMA = 'game_dev.optimization_goal.v1' as const;

const identifier = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/);
const metricIdentifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

function isPortableRelative(value: string, allowDot: boolean): boolean {
  if (value.includes('\0') || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '..')) return false;
  if (!allowDot && segments.some((segment) => segment === '.')) return false;
  return allowDot ? value === '.' || segments.every((segment) => segment !== '.') : true;
}

export const relativePathSchema = z.string().min(1).max(1024).refine(
  (value) => isPortableRelative(value, false),
  'must be a portable relative path without empty, dot, or parent segments',
);

const workingDirectorySchema = z.string().min(1).max(1024).refine(
  (value) => isPortableRelative(value, true),
  'must be . or a portable relative path without parent segments',
);

const parameterName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(64).refine(
  (value) => !/(?:token|secret|password|credential|api_?key)/i.test(value),
  'secret-bearing parameters are forbidden; use Keychain or a provider-specific credential channel',
);

const stringParameterSchema = z.object({
  type: z.literal('string'),
  description: z.string().min(1).max(400).optional(),
  required: z.boolean().default(true),
  default: z.string().max(4096).optional(),
  pattern: z.string().max(512).optional(),
}).strict();

const integerParameterSchema = z.object({
  type: z.literal('integer'),
  description: z.string().min(1).max(400).optional(),
  required: z.boolean().default(true),
  default: z.number().int().safe().optional(),
  minimum: z.number().int().safe().optional(),
  maximum: z.number().int().safe().optional(),
}).strict().superRefine((value, context) => {
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'minimum must not exceed maximum' });
  }
});

const enumParameterSchema = z.object({
  type: z.literal('enum'),
  description: z.string().min(1).max(400).optional(),
  required: z.boolean().default(true),
  values: z.array(z.string().min(1).max(256)).min(1).max(128),
  default: z.string().max(256).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.values).size !== value.values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'enum values must be unique' });
  }
  if (value.default !== undefined && !value.values.includes(value.default)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'default must be one of values' });
  }
});

const projectPathParameterSchema = z.object({
  type: z.literal('project_path'),
  description: z.string().min(1).max(400).optional(),
  required: z.boolean().default(true),
  default: relativePathSchema.optional(),
  mustExist: z.boolean().default(true),
  kind: z.enum(['file', 'directory', 'any']).default('any'),
}).strict();

export const adapterParameterSchema = z.union([
  stringParameterSchema,
  integerParameterSchema,
  enumParameterSchema,
  projectPathParameterSchema,
]);

const scenarioSchema = z.object({
  id: identifier,
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1200).optional(),
  command: z.object({
    executable: relativePathSchema,
    arguments: z.array(z.string().max(4096)).max(256).default([]),
    workingDirectory: workingDirectorySchema.default('.'),
  }).strict(),
  timeoutSeconds: z.number().int().min(1).max(7200).default(300),
  capabilities: z.array(z.enum([
    'cpu',
    'project-write',
    'gpu',
    'performance',
    // Graphics lanes. These describe WHICH api the scenario asks for; none of
    // them weakens the `gpu` gate, which is still what authorizes hardware use.
    'metal',
    'vulkan',
    'webgpu',
    'opengl',
    // A software rasterizer is not a GPU. It runs on the CPU authorization
    // path deliberately: demanding --allow-gpu for lavapipe would train users
    // to grant GPU authority for runs that never touch one.
    'software-raster',
    // The bound was `.max(5)` against exactly five members, so declaring every
    // capability was already impossible and adding one made it worse.
  ])).min(1).max(16).default(['cpu']),
  parameters: z.record(parameterName, adapterParameterSchema).default({}),
  outputs: z.object({
    format: z.enum(['none', 'game-dev-capture-v1', 'genome-hemera-v1']),
    path: relativePathSchema.optional(),
  }).strict().default({ format: 'none' }),
}).strict().superRefine((value, context) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'capabilities must be unique' });
  }
  if (Object.keys(value.parameters).length > 64) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'a scenario may declare at most 64 parameters' });
  }
  const templates = [value.command.executable, ...value.command.arguments, value.outputs.path ?? ''];
  for (const template of templates) {
    for (const match of template.matchAll(/\{param\.([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      const name = match[1];
      if (name !== undefined && value.parameters[name] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `template references undeclared parameter ${name}`,
        });
      }
    }
    const withoutKnown = template.replace(/\{(?:run_dir|run_id|project_root|param\.[A-Za-z][A-Za-z0-9_]*)\}/g, '');
    if (/[{}]/.test(withoutKnown)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `unknown template placeholder in ${template}` });
    }
  }
  if (value.outputs.format !== 'none' && value.outputs.path === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'capture outputs require a relative path' });
  }
});

export const adapterManifestSchema = z.object({
  schema: z.literal(GAME_DEV_ADAPTER_SCHEMA),
  id: identifier,
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(64),
  description: z.string().min(1).max(1200).optional(),
  scenarios: z.array(scenarioSchema).min(1).max(128),
}).strict().superRefine((value, context) => {
  const ids = value.scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'scenario ids must be unique' });
  }
});

export type AdapterManifest = z.infer<typeof adapterManifestSchema>;
export type AdapterScenario = z.infer<typeof scenarioSchema>;
export type AdapterParameter = z.infer<typeof adapterParameterSchema>;

export const captureAttachmentSchema = z.object({
  kind: z.enum([
    'color',
    'depth',
    'normal',
    'object_id',
    'material_id',
    'motion',
    'overdraw',
    /** Unlit base colour: separates a texture-binding failure from a lighting one. */
    'albedo',
    /**
     * Geometry only. Bisects "the geometry is wrong" from "the shading is
     * wrong": a black colour buffer with correct wireframe silhouettes means
     * the mesh and transforms are fine and the bug is in lighting or material.
     */
    'wireframe',
    /**
     * The scene re-rendered with a procedural checker instead of albedo.
     * Flipped or mirrored UVs, wrong tiling, a missing second UV set and
     * inconsistent texel density are all invisible in a normal colour render
     * and obvious here.
     */
    'uv_checker',
    /** False-coloured sampled LOD: missing mips, wrong bias, shimmer causes. */
    'mipmap_level',
    /** Portal, decal, outline and shadow-volume masks, inferable from nothing else. */
    'stencil',
    /**
     * Per-pixel cost. Localizes WHERE a frame-time regression lives, which
     * pass-level timings cannot. Engine-authored, so `description` must state
     * the cost model.
     */
    'shader_complexity',
    /** Lights per tile or cluster: why adding lights made this slow. */
    'light_complexity',
    'custom',
    // Deliberately NOT a kind: `histogram`. A histogram is a statistic derived
    // from the colour buffer, not a distinct render output, and accepting one
    // invites an engine to report a histogram that disagrees with its own
    // pixels -- an unverifiable claim. The harness computes it from bytes it
    // already decodes instead.
  ]),
  label: identifier.optional(),
  path: relativePathSchema,
  encoding: z.enum(['png', 'json', 'jsonl', 'binary']),
  description: z.string().min(1).max(400).optional(),
}).strict();

export const captureManifestSchema = z.object({
  schema: z.literal(GAME_DEV_CAPTURE_SCHEMA),
  runId: identifier,
  adapterId: identifier,
  scenarioId: identifier,
  sourceFormat: z.enum(['game-dev-capture-v1', 'genome-hemera-v1']),
  frames: z.array(z.object({
    index: z.number().int().min(0),
    label: identifier.optional(),
    simulationTick: z.number().int().min(0).optional(),
    attachments: z.array(captureAttachmentSchema).min(1).max(64),
  }).strict()).max(4096),
  telemetry: z.array(relativePathSchema).max(256).default([]),
  profiles: z.array(relativePathSchema).max(256).default([]),
  measurements: z.array(z.object({
    metric: metricIdentifier,
    value: z.number().finite(),
    unit: z.string().min(1).max(48),
    frameIndex: z.number().int().min(0).optional(),
    aggregation: z.enum(['sample', 'mean', 'median', 'p95', 'p99', 'min', 'max']).default('sample'),
  }).strict()).max(100_000).default([]),
  adapterEvidence: z.object({
    windowless: z.boolean().optional(),
    graphicsApi: z.string().min(1).max(64).optional(),
    /**
     * Whether a real GPU produced these pixels.
     *
     * Declared by the adapter and then INDEPENDENTLY DOWNGRADED by the harness
     * when it says `software`: see run-bundle. A lane running on lavapipe or
     * SwiftShader must not be able to mint GPU authority by claiming otherwise.
     */
    rendererClass: z.enum(['hardware', 'software', 'unknown']).default('unknown'),
    gpuExecutionReported: z.boolean().default(false),
    gpuCompletionIdentityReported: z.boolean().default(false),
    hardwarePerformanceReported: z.boolean().default(false),
    pixelVisualInspectionPerformed: z.boolean().default(false),
    notes: z.array(z.string().min(1).max(800)).max(64).default([]),
  }).strict().default({}),
}).strict().superRefine((value, context) => {
  const indexes = value.frames.map((frame) => frame.index);
  if (new Set(indexes).size !== indexes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'frame indexes must be unique' });
  }
  for (const frame of value.frames) {
    const keys = frame.attachments.map((attachment) => `${attachment.kind}:${attachment.label ?? ''}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `frame ${frame.index} has duplicate attachment identities`,
      });
    }
  }
});

export type CaptureManifest = z.infer<typeof captureManifestSchema>;
export type CaptureAttachment = z.infer<typeof captureAttachmentSchema>;

export const telemetryEventSchema = z.object({
  schema: z.literal(GAME_DEV_TELEMETRY_SCHEMA),
  runId: identifier,
  sequence: z.number().int().min(0),
  timestampNs: z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]),
  category: z.enum(['render', 'performance', 'gameplay', 'resource', 'diagnostic']),
  name: metricIdentifier,
  frameIndex: z.number().int().min(0).optional(),
  value: z.number().finite().optional(),
  unit: z.string().min(1).max(48).optional(),
  attributes: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).default({}),
}).strict().superRefine((value, context) => {
  if ((value.value === undefined) !== (value.unit === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'value and unit must appear together' });
  }
});

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

export const runArtifactSchema = z.object({
  path: relativePathSchema,
  kind: z.enum([
    'adapter', 'request', 'plan', 'stdout', 'stderr', 'capture_manifest',
    'capture_color', 'capture_depth', 'capture_semantic', 'telemetry',
    'profile', 'native_evidence', 'comparison', 'receipt', 'other',
  ]),
  bytes: z.number().int().min(0),
  sha256,
}).strict();

export const runManifestSchema = z.object({
  schema: z.literal(GAME_DEV_RUN_SCHEMA),
  runId: identifier,
  adapterId: identifier,
  adapterVersion: z.string().min(1).max(64),
  adapterManifestSha256: sha256,
  scenarioId: identifier,
  projectRoot: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  status: z.enum(['completed', 'failed', 'timed_out']),
  process: z.object({
    executable: z.string().min(1),
    arguments: z.array(z.string()),
    workingDirectory: z.string().min(1),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  }).strict(),
  failure: z.object({
    code: z.string().min(1).max(96),
    message: z.string().min(1).max(4000),
  }).strict().optional(),
  captureManifest: relativePathSchema.optional(),
  artifacts: z.array(runArtifactSchema).max(20_000),
  evidence: z.object({
    commandExecuted: z.boolean(),
    processExitedSuccessfully: z.boolean(),
    artifactRosterClosedAndHashed: z.literal(true),
    captureContractValidated: z.boolean(),
    rasterBytesDecoded: z.boolean(),
    /**
     * What the harness concluded the renderer was, after applying its own
     * downgrade -- not merely what the adapter claimed.
     */
    rendererClass: z.enum(['hardware', 'software', 'unknown']),
    /** True when the harness refused GPU and timing claims for this run. */
    softwareRasterizedLane: z.boolean(),
    adapterReportedGpuExecution: z.boolean(),
    adapterReportedGpuCompletionIdentity: z.boolean(),
    adapterReportedHardwarePerformance: z.boolean(),
    hardwareGpuExecutionProvenByHarnessAlone: z.literal(false),
    hardwarePerformanceEvidenceAdmitted: z.boolean(),
    hardwarePerformanceMeasuredByHarnessAlone: z.literal(false),
    humanVisualReviewPerformed: z.literal(false),
    evidenceCeiling: z.string().min(1),
  }).strict(),
}).strict();

export type RunManifest = z.infer<typeof runManifestSchema>;
export type RunArtifact = z.infer<typeof runArtifactSchema>;

export const metricStatisticsSchema = z.object({
  metric: metricIdentifier,
  unit: z.string().min(1).max(48),
  samples: z.number().int().min(1),
  min: z.number().finite(),
  max: z.number().finite(),
  mean: z.number().finite(),
  median: z.number().finite(),
  p95: z.number().finite(),
  p99: z.number().finite(),
  standardDeviation: z.number().finite(),
}).strict();

export type MetricStatistics = z.infer<typeof metricStatisticsSchema>;

export const optimizationGoalSchema = z.object({
  schema: z.literal(GAME_DEV_OPTIMIZATION_GOAL_SCHEMA),
  id: identifier,
  projectRoot: z.string().min(1),
  adapterId: identifier,
  scenarioId: identifier,
  metric: metricIdentifier,
  statistic: z.enum(['mean', 'median', 'p95', 'p99', 'min', 'max']),
  unit: z.string().min(1).max(48),
  direction: z.enum(['lower', 'higher']),
  target: z.number().finite(),
  maximumIterations: z.number().int().min(1).max(50),
  allowedPaths: z.array(relativePathSchema).min(1).max(256),
  baseline: z.object({
    runId: identifier,
    runPath: z.string().min(1),
    value: z.number().finite(),
  }).strict(),
  createdAt: z.string().datetime(),
  state: z.object({
    status: z.enum(['active', 'met', 'exhausted']),
    iterations: z.array(z.object({
      iteration: z.number().int().min(1),
      runId: identifier,
      runPath: z.string().min(1),
      value: z.number().finite(),
      targetMet: z.boolean(),
      evaluatedAt: z.string().datetime(),
    }).strict()).max(50),
  }).strict(),
}).strict();

export type OptimizationGoal = z.infer<typeof optimizationGoalSchema>;
