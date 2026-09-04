/*
 * The smallest engine that produces a valid capture.
 *
 * There is no graphics API here at all: the "renderer" fills a buffer on the
 * CPU. That is the point of the example -- it shows exactly what the SDK
 * needs from an engine and nothing else, and it runs anywhere a C compiler
 * does, which is what lets the harness's own test suite drive it.
 *
 * A real engine replaces `render` with a readback from its GPU and declares
 * the backend it actually used.
 */

#include "../../c/gdprobe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIDTH 16
#define HEIGHT 8

/* Left half object 1 in red, right half object 2 in blue. A "brightness"
   argument shifts the red channel so two runs can differ deterministically. */
static void render(unsigned char *rgba, uint32_t *ids, int brightness) {
  for (int y = 0; y < HEIGHT; y += 1) {
    for (int x = 0; x < WIDTH; x += 1) {
      size_t offset = ((size_t) y * WIDTH + x) * 4;
      int left = x < WIDTH / 2;
      rgba[offset + 0] = (unsigned char) (left ? 200 + brightness : 20);
      rgba[offset + 1] = 40;
      rgba[offset + 2] = (unsigned char) (left ? 20 : 200);
      rgba[offset + 3] = 255;
      ids[(size_t) y * WIDTH + x] = left ? 1u : 2u;
    }
  }
}

int main(int argc, char **argv) {
  int brightness = argc > 1 ? atoi(argv[1]) : 0;

  gdprobe_status status;
  gdprobe_run *run = gdprobe_run_begin(&status);
  if (!run) {
    if (status == GDPROBE_NOT_ATTACHED) {
      /* Not under the harness. A real engine just keeps rendering. */
      puts("not attached to the harness; rendering normally");
      return 0;
    }
    fprintf(stderr, "probe failed to start: %d\n", (int) status);
    return 1;
  }

  /* Honest about what this is: pixels from a CPU loop. */
  gdprobe_declare_backend(run, GDPROBE_BACKEND_UNKNOWN, "cpu-fill", "example",
                          GDPROBE_RENDERER_SOFTWARE);

  unsigned char rgba[WIDTH * HEIGHT * 4];
  uint32_t ids[WIDTH * HEIGHT];
  render(rgba, ids, brightness);

  gdprobe_frame *frame = gdprobe_frame_begin(run, 0, "Main View");
  if (!frame) { fprintf(stderr, "%s\n", gdprobe_last_error(run)); return 1; }
  if (gdprobe_attach_rgba8(frame, GDPROBE_KIND_COLOR, NULL, rgba, WIDTH, HEIGHT, WIDTH * 4) != GDPROBE_OK
      || gdprobe_attach_ids(frame, GDPROBE_KIND_OBJECT_ID, NULL, ids, WIDTH, HEIGHT, WIDTH * 4) != GDPROBE_OK) {
    fprintf(stderr, "%s\n", gdprobe_last_error(run));
    return 1;
  }
  gdprobe_frame_end(frame);

  /* A few frames of timing, the first one slow like a real cold start. */
  gdprobe_emit(run, "performance", "frame_time", 48.0, "ms", 0);
  for (int i = 1; i < 12; i += 1) {
    gdprobe_emit(run, "performance", "frame_time", 16.0 + (i % 3), "ms", i);
  }
  gdprobe_measure(run, "render.draw_calls", 2.0, "count", "sample", 0);

  /* A software renderer must not attest GPU execution; the SDK refuses. */
  if (gdprobe_attest_gpu(run, GDPROBE_GPU_FENCE_SIGNALLED, "should be refused") == GDPROBE_OK) {
    fprintf(stderr, "sdk accepted a gpu attestation from a software renderer\n");
    return 1;
  }

  status = gdprobe_run_end(run);
  if (status != GDPROBE_OK) {
    /* The run survives a failed end so the reason is readable. */
    fprintf(stderr, "probe failed to finish: %s\n", gdprobe_last_error(run));
    gdprobe_run_discard(run);
    return 1;
  }
  return 0;
}
