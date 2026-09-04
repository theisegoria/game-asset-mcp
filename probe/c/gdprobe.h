/*
 * gdprobe -- write a Game Development Studio capture bundle from your engine.
 *
 * WHY THIS EXISTS. The harness contract is four environment variables and a
 * capture manifest. That is a small contract, and every engine that implements
 * it by hand gets the same handful of things wrong: labels that are not
 * lowercase identifiers, a telemetry sequence that is not strictly increasing,
 * a manifest written before the files it names, a row stride assumed to equal
 * width times bytes-per-pixel. Each one fails validation after the run, when
 * the frame is gone.
 *
 * So this library's job is not convenience. It is to make an invalid bundle
 * unrepresentable: the engine cannot name a path, cannot choose a sequence
 * number, and cannot write the manifest early.
 *
 * WHAT IT IS NOT. It never touches a graphics API. You synchronise, you read
 * back, you hand over a pointer and say how you know the GPU finished. Keeping
 * that boundary means one implementation serves Metal, Vulkan, WebGPU and GL
 * without knowing which one you used.
 *
 * C99, libc only. Compile gdprobe.c into your engine; there is nothing to link
 * and nothing to install.
 *
 * USAGE
 *
 *   gdprobe_run *run = gdprobe_run_begin(NULL);
 *   if (!run) { ... not running under the harness ... }
 *   gdprobe_declare_backend(run, GDPROBE_BACKEND_VULKAN, "llvmpipe", "24.0",
 *                           GDPROBE_RENDERER_SOFTWARE);
 *
 *   gdprobe_frame *frame = gdprobe_frame_begin(run, 0, "main");
 *   gdprobe_attach_rgba8(frame, GDPROBE_KIND_COLOR, NULL, pixels, w, h, stride);
 *   gdprobe_frame_end(frame);
 *
 *   gdprobe_emit(run, "performance", "frame_time", 16.7, "ms", 0);
 *   gdprobe_attest_gpu(run, GDPROBE_GPU_FENCE_SIGNALLED, "vkWaitForFences");
 *   gdprobe_run_end(run);
 */

#ifndef GDPROBE_H
#define GDPROBE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GDPROBE_CONTRACT_VERSION "1"

typedef enum {
  GDPROBE_OK = 0,
  /* Not running under the harness: GAME_DEV_RUN_DIR and friends are absent.
     This is not a failure. An engine should carry on rendering. */
  GDPROBE_NOT_ATTACHED,
  GDPROBE_ERR_ARGUMENT,
  GDPROBE_ERR_STATE,
  GDPROBE_ERR_IO,
  GDPROBE_ERR_MEMORY,
  GDPROBE_ERR_LIMIT
} gdprobe_status;

typedef enum {
  GDPROBE_BACKEND_UNKNOWN = 0,
  GDPROBE_BACKEND_METAL,
  GDPROBE_BACKEND_VULKAN,
  GDPROBE_BACKEND_WEBGPU,
  GDPROBE_BACKEND_OPENGL
} gdprobe_backend;

/*
 * Whether real hardware drew this.
 *
 * Declare SOFTWARE for lavapipe, llvmpipe or SwiftShader. The harness refuses
 * every GPU and hardware-timing claim on a software run regardless of what
 * else you report, so declaring it honestly costs you nothing you were
 * entitled to and keeps the run's evidence truthful.
 */
typedef enum {
  GDPROBE_RENDERER_UNKNOWN = 0,
  GDPROBE_RENDERER_HARDWARE,
  GDPROBE_RENDERER_SOFTWARE
} gdprobe_renderer_class;

/*
 * HOW you know the GPU finished, not merely that you believe it did.
 *
 * An enum rather than a boolean on purpose: "I called waitUntilCompleted and
 * checked the status" and "I assume it worked" are different claims, and a
 * reader of the sealed run deserves to see which one was made.
 */
typedef enum {
  GDPROBE_GPU_NOT_ATTESTED = 0,
  GDPROBE_GPU_COMMANDBUFFER_COMPLETED,
  GDPROBE_GPU_FENCE_SIGNALLED,
  GDPROBE_GPU_TIMESTAMP_RESOLVED
} gdprobe_gpu_attestation;

/* Mirrors the harness attachment kinds. */
typedef enum {
  GDPROBE_KIND_COLOR = 0,
  GDPROBE_KIND_ALBEDO,
  GDPROBE_KIND_DEPTH,
  GDPROBE_KIND_NORMAL,
  GDPROBE_KIND_OBJECT_ID,
  GDPROBE_KIND_MATERIAL_ID,
  GDPROBE_KIND_MOTION,
  GDPROBE_KIND_OVERDRAW,
  GDPROBE_KIND_WIREFRAME,
  GDPROBE_KIND_UV_CHECKER,
  GDPROBE_KIND_MIPMAP_LEVEL,
  GDPROBE_KIND_STENCIL,
  GDPROBE_KIND_SHADER_COMPLEXITY,
  GDPROBE_KIND_LIGHT_COMPLEXITY,
  GDPROBE_KIND_CUSTOM
} gdprobe_attachment_kind;

typedef struct gdprobe_run gdprobe_run;
typedef struct gdprobe_frame gdprobe_frame;

/*
 * Open a run against the directory the harness supplied.
 *
 * Returns NULL and sets *out_status to GDPROBE_NOT_ATTACHED when the
 * GAME_DEV_* variables are absent, so the same binary runs normally outside
 * the harness. out_status may be NULL.
 */
gdprobe_run *gdprobe_run_begin(gdprobe_status *out_status);

/* Human-readable reason for the last failure on this run. Never NULL. */
const char *gdprobe_last_error(const gdprobe_run *run);

void gdprobe_declare_backend(gdprobe_run *run,
                             gdprobe_backend backend,
                             const char *device_name,
                             const char *driver_version,
                             gdprobe_renderer_class renderer_class);

/* `note` records how the attestation was obtained; it reaches the sealed run. */
gdprobe_status gdprobe_attest_gpu(gdprobe_run *run,
                                  gdprobe_gpu_attestation attestation,
                                  const char *note);

/*
 * Claim that the timings in this run came from real hardware.
 *
 * Only meaningful alongside GDPROBE_RENDERER_HARDWARE, and only admitted when
 * the operator also authorised hardware-performance evidence.
 */
gdprobe_status gdprobe_attest_performance(gdprobe_run *run, int reported, const char *note);

/*
 * Begin a frame. `label` may be NULL; if given it is slugified to the
 * lowercase identifier the contract requires, so "GBuffer Pass" is accepted
 * and stored as "gbuffer-pass" rather than rejected after the run.
 */
gdprobe_frame *gdprobe_frame_begin(gdprobe_run *run, uint32_t index, const char *label);

/*
 * Attach 8-bit RGBA pixels.
 *
 * `row_stride` is bytes per row and is NOT assumed to be width * 4: wgpu
 * aligns copy rows to 256 bytes, and reading width*4 would walk into padding
 * and record it as image data.
 *
 * You do not name the file. The path is derived, which is what keeps a
 * manifest from ever pointing outside its run directory.
 */
gdprobe_status gdprobe_attach_rgba8(gdprobe_frame *frame,
                                    gdprobe_attachment_kind kind,
                                    const char *label,
                                    const void *pixels,
                                    uint32_t width,
                                    uint32_t height,
                                    size_t row_stride);

/*
 * Attach a 32-bit object or material id buffer.
 *
 * Ids are packed into RGB the way the harness unpacks them, so the semantic
 * diff can attribute changed pixels to your objects. Id 0 means "nothing".
 */
gdprobe_status gdprobe_attach_ids(gdprobe_frame *frame,
                                  gdprobe_attachment_kind kind,
                                  const char *label,
                                  const uint32_t *ids,
                                  uint32_t width,
                                  uint32_t height,
                                  size_t row_stride);

void gdprobe_frame_end(gdprobe_frame *frame);

/*
 * Emit one telemetry sample.
 *
 * The sequence number is owned by the library and increments atomically, which
 * is what makes the harness's strictly-increasing requirement structural
 * rather than something every engine has to remember.
 *
 * `frame_index` may be -1 when the sample belongs to no particular frame; only
 * samples that name a frame can be excluded as warmup later.
 */
gdprobe_status gdprobe_emit(gdprobe_run *run,
                            const char *category,
                            const char *name,
                            double value,
                            const char *unit,
                            int32_t frame_index);

/*
 * Record a measurement that is already aggregated -- a p99 you computed
 * yourself, say. Use "sample" for raw per-frame values.
 *
 * Getting this right matters: the harness groups by aggregation, and a p99
 * pooled with raw samples produces a median of a mixed bag.
 */
gdprobe_status gdprobe_measure(gdprobe_run *run,
                               const char *metric,
                               double value,
                               const char *unit,
                               const char *aggregation,
                               int32_t frame_index);

/*
 * Finish the run: flush every attachment, then write capture.json last.
 *
 * The manifest is written last on purpose. A process that dies mid-capture
 * leaves no manifest at all, so the harness reports a failed run rather than
 * validating a manifest that names truncated files.
 *
 * On success `run` is freed. On failure it is NOT, so gdprobe_last_error can
 * still explain what went wrong; release it with gdprobe_run_discard.
 */
gdprobe_status gdprobe_run_end(gdprobe_run *run);

/* Release a run without writing a manifest. Use after gdprobe_run_end fails,
   or to abandon a capture deliberately. Safe with NULL. */
void gdprobe_run_discard(gdprobe_run *run);

#ifdef __cplusplus
}
#endif

#endif /* GDPROBE_H */
