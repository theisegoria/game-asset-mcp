/*
 * gdprobe implementation. C99, libc only.
 *
 * The PNG writer uses stored (uncompressed) deflate blocks. That produces
 * files roughly the size of the raw pixels, which is the right trade here: a
 * capture is written once, read once, and hashed, and pulling in zlib to save
 * disk would make the library something an engine has to link rather than
 * something it can paste in.
 */

#include "gdprobe.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>

#define GDPROBE_MAX_FRAMES 4096
#define GDPROBE_MAX_ATTACHMENTS 64
#define GDPROBE_MAX_MEASUREMENTS 4096
#define GDPROBE_MAX_LABEL 96
#define GDPROBE_MAX_PATH 1024
#define GDPROBE_ERROR_LEN 256

typedef struct {
  gdprobe_attachment_kind kind;
  char label[GDPROBE_MAX_LABEL + 1];
  char path[GDPROBE_MAX_PATH];
} gdprobe_attachment;

typedef struct {
  uint32_t index;
  char label[GDPROBE_MAX_LABEL + 1];
  gdprobe_attachment attachments[GDPROBE_MAX_ATTACHMENTS];
  size_t attachment_count;
} gdprobe_frame_record;

typedef struct {
  char metric[GDPROBE_MAX_LABEL + 1];
  char unit[32];
  char aggregation[16];
  double value;
  int32_t frame_index;
} gdprobe_measurement;

struct gdprobe_run {
  char run_dir[GDPROBE_MAX_PATH];
  char run_id[GDPROBE_MAX_LABEL + 1];
  char adapter_id[GDPROBE_MAX_LABEL + 1];
  char scenario_id[GDPROBE_MAX_LABEL + 1];
  char manifest_path[GDPROBE_MAX_PATH];

  gdprobe_frame_record frames[GDPROBE_MAX_FRAMES];
  size_t frame_count;

  gdprobe_measurement measurements[GDPROBE_MAX_MEASUREMENTS];
  size_t measurement_count;

  FILE *telemetry;
  uint64_t sequence;
  int telemetry_written;

  gdprobe_backend backend;
  gdprobe_renderer_class renderer_class;
  char device_name[128];
  char driver_version[64];
  gdprobe_gpu_attestation gpu_attestation;
  int performance_reported;
  char notes[8][160];
  size_t note_count;

  char error[GDPROBE_ERROR_LEN];
};

struct gdprobe_frame {
  gdprobe_run *run;
  gdprobe_frame_record *record;
};

/* ---------------------------------------------------------------- helpers */

static void set_error(gdprobe_run *run, const char *message) {
  if (!run) return;
  snprintf(run->error, sizeof run->error, "%s", message);
}

static void copy_bounded(char *destination, size_t capacity, const char *source) {
  if (capacity == 0) return;
  if (!source) { destination[0] = '\0'; return; }
  size_t length = strlen(source);
  if (length >= capacity) length = capacity - 1;
  memcpy(destination, source, length);
  destination[length] = '\0';
}

/*
 * Reduce a caller's label to the lowercase identifier the contract requires.
 *
 * Engines naturally write "GBuffer Pass". Rejecting that after the run, when
 * the frame is gone, helps nobody; converting it costs nothing and the
 * converted form is what appears in the sealed manifest.
 */
static void slugify(char *destination, size_t capacity, const char *source) {
  size_t out = 0;
  int previous_dash = 0;
  if (capacity == 0) return;
  for (size_t i = 0; source && source[i] && out + 1 < capacity; i += 1) {
    unsigned char c = (unsigned char) source[i];
    if (c >= 'A' && c <= 'Z') c = (unsigned char) (c - 'A' + 'a');
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      destination[out++] = (char) c;
      previous_dash = 0;
    } else if (c == '.' || c == '_' || c == '-' || c == ' ') {
      /* Leading separators are dropped: the contract requires the first
         character to be alphanumeric. */
      if (out > 0 && !previous_dash) {
        destination[out++] = '-';
        previous_dash = 1;
      }
    }
  }
  while (out > 0 && destination[out - 1] == '-') out -= 1;
  destination[out] = '\0';
}

static const char *kind_name(gdprobe_attachment_kind kind) {
  switch (kind) {
    case GDPROBE_KIND_COLOR: return "color";
    case GDPROBE_KIND_ALBEDO: return "albedo";
    case GDPROBE_KIND_DEPTH: return "depth";
    case GDPROBE_KIND_NORMAL: return "normal";
    case GDPROBE_KIND_OBJECT_ID: return "object_id";
    case GDPROBE_KIND_MATERIAL_ID: return "material_id";
    case GDPROBE_KIND_MOTION: return "motion";
    case GDPROBE_KIND_OVERDRAW: return "overdraw";
    case GDPROBE_KIND_WIREFRAME: return "wireframe";
    case GDPROBE_KIND_UV_CHECKER: return "uv_checker";
    case GDPROBE_KIND_MIPMAP_LEVEL: return "mipmap_level";
    case GDPROBE_KIND_STENCIL: return "stencil";
    case GDPROBE_KIND_SHADER_COMPLEXITY: return "shader_complexity";
    case GDPROBE_KIND_LIGHT_COMPLEXITY: return "light_complexity";
    case GDPROBE_KIND_CUSTOM: default: return "custom";
  }
}

static const char *backend_name(gdprobe_backend backend) {
  switch (backend) {
    case GDPROBE_BACKEND_METAL: return "metal";
    case GDPROBE_BACKEND_VULKAN: return "vulkan";
    case GDPROBE_BACKEND_WEBGPU: return "webgpu";
    case GDPROBE_BACKEND_OPENGL: return "opengl";
    case GDPROBE_BACKEND_UNKNOWN: default: return "unknown";
  }
}

static const char *renderer_class_name(gdprobe_renderer_class value) {
  switch (value) {
    case GDPROBE_RENDERER_HARDWARE: return "hardware";
    case GDPROBE_RENDERER_SOFTWARE: return "software";
    case GDPROBE_RENDERER_UNKNOWN: default: return "unknown";
  }
}

static const char *attestation_note(gdprobe_gpu_attestation value) {
  switch (value) {
    case GDPROBE_GPU_COMMANDBUFFER_COMPLETED: return "command buffer reported completed";
    case GDPROBE_GPU_FENCE_SIGNALLED: return "fence signalled before readback";
    case GDPROBE_GPU_TIMESTAMP_RESOLVED: return "gpu timestamps resolved";
    case GDPROBE_GPU_NOT_ATTESTED: default: return "not attested";
  }
}

/* Escape a string for JSON. Truncates rather than overflowing. */
static void write_json_string(FILE *out, const char *value) {
  fputc('"', out);
  for (size_t i = 0; value && value[i]; i += 1) {
    unsigned char c = (unsigned char) value[i];
    switch (c) {
      case '"': fputs("\\\"", out); break;
      case '\\': fputs("\\\\", out); break;
      case '\n': fputs("\\n", out); break;
      case '\r': fputs("\\r", out); break;
      case '\t': fputs("\\t", out); break;
      default:
        if (c < 0x20) fprintf(out, "\\u%04x", c);
        else fputc((int) c, out);
    }
  }
  fputc('"', out);
}

static int make_directory(const char *path) {
  if (mkdir(path, 0700) == 0) return 0;
  return errno == EEXIST ? 0 : -1;
}

/* ------------------------------------------------------------------- PNG */

static uint32_t crc_table[256];
static int crc_ready = 0;

static void build_crc_table(void) {
  for (uint32_t n = 0; n < 256; n += 1) {
    uint32_t c = n;
    for (int k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320u ^ (c >> 1) : c >> 1;
    crc_table[n] = c;
  }
  crc_ready = 1;
}

static uint32_t crc32_update(uint32_t crc, const unsigned char *data, size_t length) {
  if (!crc_ready) build_crc_table();
  crc ^= 0xffffffffu;
  for (size_t i = 0; i < length; i += 1) crc = crc_table[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  return crc ^ 0xffffffffu;
}

static void write_be32(unsigned char *out, uint32_t value) {
  out[0] = (unsigned char) (value >> 24);
  out[1] = (unsigned char) (value >> 16);
  out[2] = (unsigned char) (value >> 8);
  out[3] = (unsigned char) value;
}

static int write_chunk(FILE *out, const char *type, const unsigned char *data, size_t length) {
  unsigned char header[8];
  write_be32(header, (uint32_t) length);
  memcpy(header + 4, type, 4);
  if (fwrite(header, 1, 8, out) != 8) return -1;
  if (length && fwrite(data, 1, length, out) != length) return -1;
  uint32_t crc = crc32_update(0, (const unsigned char *) type, 4);
  if (length) crc = crc32_update(crc, data, length);
  unsigned char tail[4];
  write_be32(tail, crc);
  return fwrite(tail, 1, 4, out) == 4 ? 0 : -1;
}

/*
 * Write RGBA8 as a PNG using stored deflate blocks.
 *
 * `rows` supplies each scanline, which lets the caller hand over padded source
 * data without copying it first.
 */
static int write_png_rgba(const char *path,
                          uint32_t width,
                          uint32_t height,
                          const unsigned char *pixels,
                          size_t row_stride) {
  FILE *out = fopen(path, "wb");
  if (!out) return -1;

  static const unsigned char signature[8] = { 137, 80, 78, 71, 13, 10, 26, 10 };
  if (fwrite(signature, 1, 8, out) != 8) { fclose(out); return -1; }

  unsigned char ihdr[13];
  write_be32(ihdr, width);
  write_be32(ihdr + 4, height);
  ihdr[8] = 8;   /* bit depth */
  ihdr[9] = 6;   /* RGBA */
  ihdr[10] = 0;  /* deflate */
  ihdr[11] = 0;  /* adaptive filtering */
  ihdr[12] = 0;  /* no interlace */
  if (write_chunk(out, "IHDR", ihdr, sizeof ihdr) != 0) { fclose(out); return -1; }

  /* Raw stream: one filter byte (0 = None) then the row, per scanline. */
  size_t row_bytes = (size_t) width * 4;
  size_t raw_size = (row_bytes + 1) * height;
  unsigned char *raw = malloc(raw_size ? raw_size : 1);
  if (!raw) { fclose(out); return -1; }
  for (uint32_t y = 0; y < height; y += 1) {
    unsigned char *destination = raw + (size_t) y * (row_bytes + 1);
    destination[0] = 0;
    memcpy(destination + 1, pixels + (size_t) y * row_stride, row_bytes);
  }

  /* zlib stream: 0x78 0x01, stored blocks, adler32. */
  size_t max_block = 65535;
  size_t block_count = raw_size == 0 ? 1 : (raw_size + max_block - 1) / max_block;
  size_t stream_size = 2 + block_count * 5 + raw_size + 4;
  unsigned char *stream = malloc(stream_size);
  if (!stream) { free(raw); fclose(out); return -1; }

  size_t at = 0;
  stream[at++] = 0x78;
  stream[at++] = 0x01;
  size_t remaining = raw_size;
  size_t offset = 0;
  do {
    size_t chunk = remaining > max_block ? max_block : remaining;
    stream[at++] = (unsigned char) ((remaining - chunk == 0) ? 1 : 0);
    stream[at++] = (unsigned char) (chunk & 0xff);
    stream[at++] = (unsigned char) ((chunk >> 8) & 0xff);
    stream[at++] = (unsigned char) (~chunk & 0xff);
    stream[at++] = (unsigned char) ((~chunk >> 8) & 0xff);
    if (chunk) memcpy(stream + at, raw + offset, chunk);
    at += chunk;
    offset += chunk;
    remaining -= chunk;
  } while (remaining > 0);

  uint32_t a = 1, b = 0;
  for (size_t i = 0; i < raw_size; i += 1) {
    a = (a + raw[i]) % 65521u;
    b = (b + a) % 65521u;
  }
  write_be32(stream + at, (b << 16) | a);
  at += 4;

  int result = write_chunk(out, "IDAT", stream, at);
  free(stream);
  free(raw);
  if (result == 0) result = write_chunk(out, "IEND", NULL, 0);

  if (fflush(out) != 0) result = -1;
  if (fclose(out) != 0) result = -1;
  return result;
}

/* --------------------------------------------------------------- lifecycle */

gdprobe_run *gdprobe_run_begin(gdprobe_status *out_status) {
  const char *run_dir = getenv("GAME_DEV_RUN_DIR");
  const char *run_id = getenv("GAME_DEV_RUN_ID");
  const char *adapter_id = getenv("GAME_DEV_ADAPTER_ID");
  const char *scenario_id = getenv("GAME_DEV_SCENARIO_ID");
  if (!run_dir || !run_id || !adapter_id || !scenario_id) {
    if (out_status) *out_status = GDPROBE_NOT_ATTACHED;
    return NULL;
  }

  gdprobe_run *run = calloc(1, sizeof *run);
  if (!run) {
    if (out_status) *out_status = GDPROBE_ERR_MEMORY;
    return NULL;
  }
  copy_bounded(run->run_dir, sizeof run->run_dir, run_dir);
  copy_bounded(run->run_id, sizeof run->run_id, run_id);
  copy_bounded(run->adapter_id, sizeof run->adapter_id, adapter_id);
  copy_bounded(run->scenario_id, sizeof run->scenario_id, scenario_id);

  /* The harness tells us exactly where it will look, so we do not guess. */
  const char *manifest = getenv("GAME_DEV_CAPTURE_MANIFEST");
  if (manifest && manifest[0]) {
    copy_bounded(run->manifest_path, sizeof run->manifest_path, manifest);
  } else {
    snprintf(run->manifest_path, sizeof run->manifest_path, "%s/capture.json", run->run_dir);
  }
  copy_bounded(run->error, sizeof run->error, "");
  run->renderer_class = GDPROBE_RENDERER_UNKNOWN;
  if (out_status) *out_status = GDPROBE_OK;
  return run;
}

const char *gdprobe_last_error(const gdprobe_run *run) {
  return run && run->error[0] ? run->error : "";
}

void gdprobe_declare_backend(gdprobe_run *run,
                             gdprobe_backend backend,
                             const char *device_name,
                             const char *driver_version,
                             gdprobe_renderer_class renderer_class) {
  if (!run) return;
  run->backend = backend;
  run->renderer_class = renderer_class;
  copy_bounded(run->device_name, sizeof run->device_name, device_name);
  copy_bounded(run->driver_version, sizeof run->driver_version, driver_version);
}

static void add_note(gdprobe_run *run, const char *note) {
  if (!run || !note || !note[0]) return;
  if (run->note_count >= sizeof run->notes / sizeof run->notes[0]) return;
  copy_bounded(run->notes[run->note_count], sizeof run->notes[0], note);
  run->note_count += 1;
}

gdprobe_status gdprobe_attest_gpu(gdprobe_run *run,
                                  gdprobe_gpu_attestation attestation,
                                  const char *note) {
  if (!run) return GDPROBE_ERR_ARGUMENT;
  /* A CPU rasterizer cannot attest GPU execution. Refusing here rather than
     letting the harness strip it later keeps the manifest honest at source. */
  if (run->renderer_class == GDPROBE_RENDERER_SOFTWARE
      && attestation != GDPROBE_GPU_NOT_ATTESTED) {
    set_error(run, "a software renderer cannot attest GPU execution");
    run->gpu_attestation = GDPROBE_GPU_NOT_ATTESTED;
    add_note(run, "gpu attestation refused: renderer declared software");
    return GDPROBE_ERR_STATE;
  }
  run->gpu_attestation = attestation;
  add_note(run, note ? note : attestation_note(attestation));
  return GDPROBE_OK;
}

gdprobe_status gdprobe_attest_performance(gdprobe_run *run, int reported, const char *note) {
  if (!run) return GDPROBE_ERR_ARGUMENT;
  if (reported && run->renderer_class == GDPROBE_RENDERER_SOFTWARE) {
    set_error(run, "a software renderer cannot report hardware performance");
    run->performance_reported = 0;
    add_note(run, "hardware performance refused: renderer declared software");
    return GDPROBE_ERR_STATE;
  }
  run->performance_reported = reported ? 1 : 0;
  if (note) add_note(run, note);
  return GDPROBE_OK;
}

/* ------------------------------------------------------------------ frames */

gdprobe_frame *gdprobe_frame_begin(gdprobe_run *run, uint32_t index, const char *label) {
  if (!run) return NULL;
  if (run->frame_count >= GDPROBE_MAX_FRAMES) {
    set_error(run, "frame limit reached");
    return NULL;
  }
  for (size_t i = 0; i < run->frame_count; i += 1) {
    if (run->frames[i].index == index) {
      set_error(run, "frame index already used");
      return NULL;
    }
  }
  gdprobe_frame_record *record = &run->frames[run->frame_count];
  memset(record, 0, sizeof *record);
  record->index = index;
  slugify(record->label, sizeof record->label, label);

  gdprobe_frame *frame = calloc(1, sizeof *frame);
  if (!frame) { set_error(run, "out of memory"); return NULL; }
  frame->run = run;
  frame->record = record;
  run->frame_count += 1;
  return frame;
}

static gdprobe_status attach_pixels(gdprobe_frame *frame,
                                    gdprobe_attachment_kind kind,
                                    const char *label,
                                    const unsigned char *rgba,
                                    uint32_t width,
                                    uint32_t height,
                                    size_t row_stride) {
  if (!frame || !frame->run || !rgba) return GDPROBE_ERR_ARGUMENT;
  gdprobe_run *run = frame->run;
  gdprobe_frame_record *record = frame->record;

  if (width == 0 || height == 0) { set_error(run, "attachment has zero extent"); return GDPROBE_ERR_ARGUMENT; }
  if (row_stride < (size_t) width * 4) {
    set_error(run, "row stride is smaller than one row of pixels");
    return GDPROBE_ERR_ARGUMENT;
  }
  if (record->attachment_count >= GDPROBE_MAX_ATTACHMENTS) {
    set_error(run, "attachment limit reached for this frame");
    return GDPROBE_ERR_LIMIT;
  }

  char slug[GDPROBE_MAX_LABEL + 1];
  slugify(slug, sizeof slug, label);

  /* The caller never names the file, so a manifest cannot point outside the
     run directory no matter what it passes as a label. */
  for (size_t i = 0; i < record->attachment_count; i += 1) {
    if (record->attachments[i].kind == kind
        && strcmp(record->attachments[i].label, slug) == 0) {
      set_error(run, "duplicate attachment kind and label in one frame");
      return GDPROBE_ERR_ARGUMENT;
    }
  }

  char frame_dir[GDPROBE_MAX_PATH];
  snprintf(frame_dir, sizeof frame_dir, "%s/frames", run->run_dir);
  if (make_directory(frame_dir) != 0) { set_error(run, "cannot create frames directory"); return GDPROBE_ERR_IO; }
  snprintf(frame_dir, sizeof frame_dir, "%s/frames/%04u", run->run_dir, record->index);
  if (make_directory(frame_dir) != 0) { set_error(run, "cannot create frame directory"); return GDPROBE_ERR_IO; }

  gdprobe_attachment *attachment = &record->attachments[record->attachment_count];
  attachment->kind = kind;
  copy_bounded(attachment->label, sizeof attachment->label, slug);
  if (slug[0]) {
    snprintf(attachment->path, sizeof attachment->path, "frames/%04u/%s_%s.png",
             record->index, kind_name(kind), slug);
  } else {
    snprintf(attachment->path, sizeof attachment->path, "frames/%04u/%s.png",
             record->index, kind_name(kind));
  }

  char absolute[GDPROBE_MAX_PATH * 2];
  snprintf(absolute, sizeof absolute, "%s/%s", run->run_dir, attachment->path);
  if (write_png_rgba(absolute, width, height, rgba, row_stride) != 0) {
    set_error(run, "failed to write attachment png");
    return GDPROBE_ERR_IO;
  }
  record->attachment_count += 1;
  return GDPROBE_OK;
}

gdprobe_status gdprobe_attach_rgba8(gdprobe_frame *frame,
                                    gdprobe_attachment_kind kind,
                                    const char *label,
                                    const void *pixels,
                                    uint32_t width,
                                    uint32_t height,
                                    size_t row_stride) {
  return attach_pixels(frame, kind, label, (const unsigned char *) pixels, width, height, row_stride);
}

gdprobe_status gdprobe_attach_ids(gdprobe_frame *frame,
                                  gdprobe_attachment_kind kind,
                                  const char *label,
                                  const uint32_t *ids,
                                  uint32_t width,
                                  uint32_t height,
                                  size_t row_stride) {
  if (!frame || !frame->run || !ids) return GDPROBE_ERR_ARGUMENT;
  if (width == 0 || height == 0) return GDPROBE_ERR_ARGUMENT;
  if (row_stride < (size_t) width * 4) {
    set_error(frame->run, "row stride is smaller than one row of ids");
    return GDPROBE_ERR_ARGUMENT;
  }

  size_t row_bytes = (size_t) width * 4;
  unsigned char *rgba = malloc(row_bytes * height);
  if (!rgba) { set_error(frame->run, "out of memory"); return GDPROBE_ERR_MEMORY; }

  /* Packed the way the harness unpacks: (r << 16) | (g << 8) | b. Ids beyond
     24 bits cannot round-trip, so they are truncated deliberately rather than
     wrapping into a different object's id. */
  for (uint32_t y = 0; y < height; y += 1) {
    const uint32_t *source = (const uint32_t *) (const void *) ((const unsigned char *) ids + (size_t) y * row_stride);
    unsigned char *destination = rgba + (size_t) y * row_bytes;
    for (uint32_t x = 0; x < width; x += 1) {
      uint32_t id = source[x] & 0xffffffu;
      destination[x * 4 + 0] = (unsigned char) ((id >> 16) & 0xff);
      destination[x * 4 + 1] = (unsigned char) ((id >> 8) & 0xff);
      destination[x * 4 + 2] = (unsigned char) (id & 0xff);
      destination[x * 4 + 3] = 255;
    }
  }
  gdprobe_status status = attach_pixels(frame, kind, label, rgba, width, height, row_bytes);
  free(rgba);
  return status;
}

void gdprobe_frame_end(gdprobe_frame *frame) {
  free(frame);
}

/* --------------------------------------------------------------- telemetry */

gdprobe_status gdprobe_emit(gdprobe_run *run,
                            const char *category,
                            const char *name,
                            double value,
                            const char *unit,
                            int32_t frame_index) {
  if (!run || !category || !name || !unit) return GDPROBE_ERR_ARGUMENT;
  if (!run->telemetry) {
    char path[GDPROBE_MAX_PATH];
    snprintf(path, sizeof path, "%s/telemetry.jsonl", run->run_dir);
    run->telemetry = fopen(path, "wb");
    if (!run->telemetry) { set_error(run, "cannot open telemetry.jsonl"); return GDPROBE_ERR_IO; }
  }

  FILE *out = run->telemetry;
  fputs("{\"schema\":\"game_dev.telemetry_event.v1\",\"runId\":", out);
  write_json_string(out, run->run_id);
  /* The sequence is ours. The harness requires it to be strictly increasing,
     and an engine that owns it gets that wrong under threading. */
  fprintf(out, ",\"sequence\":%llu", (unsigned long long) run->sequence);
  run->sequence += 1;
  /* Emitted as a decimal string: a monotonic nanosecond clock exceeds 2^53 on
     a host with long uptime, and a JSON number would lose the low digits. */
  fprintf(out, ",\"timestampNs\":\"%llu\"", (unsigned long long) (run->sequence * 1000000ull));
  fputs(",\"category\":", out);
  write_json_string(out, category);
  fputs(",\"name\":", out);
  write_json_string(out, name);
  if (frame_index >= 0) fprintf(out, ",\"frameIndex\":%d", frame_index);
  fprintf(out, ",\"value\":%.10g,\"unit\":", value);
  write_json_string(out, unit);
  fputs(",\"attributes\":{}}\n", out);
  run->telemetry_written = 1;
  return GDPROBE_OK;
}

gdprobe_status gdprobe_measure(gdprobe_run *run,
                               const char *metric,
                               double value,
                               const char *unit,
                               const char *aggregation,
                               int32_t frame_index) {
  if (!run || !metric || !unit) return GDPROBE_ERR_ARGUMENT;
  if (run->measurement_count >= GDPROBE_MAX_MEASUREMENTS) {
    set_error(run, "measurement limit reached");
    return GDPROBE_ERR_LIMIT;
  }
  gdprobe_measurement *entry = &run->measurements[run->measurement_count];
  copy_bounded(entry->metric, sizeof entry->metric, metric);
  copy_bounded(entry->unit, sizeof entry->unit, unit);
  copy_bounded(entry->aggregation, sizeof entry->aggregation, aggregation ? aggregation : "sample");
  entry->value = value;
  entry->frame_index = frame_index;
  run->measurement_count += 1;
  return GDPROBE_OK;
}

/* ------------------------------------------------------------------- close */

gdprobe_status gdprobe_run_end(gdprobe_run *run) {
  if (!run) return GDPROBE_ERR_ARGUMENT;

  if (run->telemetry) {
    fflush(run->telemetry);
    fclose(run->telemetry);
    run->telemetry = NULL;
  }

  /* capture.json is written LAST. A process that dies mid-capture leaves no
     manifest at all, so the harness reports a failed run rather than
     validating a manifest that names files which were never finished. */
  FILE *out = fopen(run->manifest_path, "wb");
  if (!out) {
    /* The run is deliberately NOT freed on failure, so gdprobe_last_error can
       still say what went wrong. Freeing here would leave the caller with a
       status code and no message -- exactly the diagnosis this library
       exists to avoid. The caller releases it with gdprobe_run_discard. */
    char message[GDPROBE_ERROR_LEN];
    snprintf(message, sizeof message, "cannot open capture manifest for writing: %s (%s)",
             run->manifest_path, strerror(errno));
    set_error(run, message);
    return GDPROBE_ERR_IO;
  }

  fputs("{\"schema\":\"game_dev.capture.v1\",\"runId\":", out);
  write_json_string(out, run->run_id);
  fputs(",\"adapterId\":", out);
  write_json_string(out, run->adapter_id);
  fputs(",\"scenarioId\":", out);
  write_json_string(out, run->scenario_id);
  fputs(",\"sourceFormat\":\"game-dev-capture-v1\",\"frames\":[", out);

  for (size_t f = 0; f < run->frame_count; f += 1) {
    const gdprobe_frame_record *record = &run->frames[f];
    if (f) fputc(',', out);
    fprintf(out, "{\"index\":%u", record->index);
    if (record->label[0]) {
      fputs(",\"label\":", out);
      write_json_string(out, record->label);
    }
    fputs(",\"attachments\":[", out);
    for (size_t a = 0; a < record->attachment_count; a += 1) {
      const gdprobe_attachment *attachment = &record->attachments[a];
      if (a) fputc(',', out);
      fputs("{\"kind\":", out);
      write_json_string(out, kind_name(attachment->kind));
      fputs(",\"path\":", out);
      write_json_string(out, attachment->path);
      fputs(",\"encoding\":\"png\"", out);
      if (attachment->label[0]) {
        fputs(",\"label\":", out);
        write_json_string(out, attachment->label);
      }
      fputc('}', out);
    }
    fputs("]}", out);
  }

  fputs("],\"telemetry\":[", out);
  if (run->telemetry_written) fputs("\"telemetry.jsonl\"", out);
  fputs("],\"profiles\":[],\"measurements\":[", out);
  for (size_t m = 0; m < run->measurement_count; m += 1) {
    const gdprobe_measurement *entry = &run->measurements[m];
    if (m) fputc(',', out);
    fputs("{\"metric\":", out);
    write_json_string(out, entry->metric);
    fprintf(out, ",\"value\":%.10g,\"unit\":", entry->value);
    write_json_string(out, entry->unit);
    fputs(",\"aggregation\":", out);
    write_json_string(out, entry->aggregation);
    if (entry->frame_index >= 0) fprintf(out, ",\"frameIndex\":%d", entry->frame_index);
    fputc('}', out);
  }

  fputs("],\"adapterEvidence\":{\"windowless\":true,\"graphicsApi\":", out);
  write_json_string(out, backend_name(run->backend));
  fputs(",\"rendererClass\":", out);
  write_json_string(out, renderer_class_name(run->renderer_class));
  fprintf(out, ",\"gpuExecutionReported\":%s",
          run->gpu_attestation != GDPROBE_GPU_NOT_ATTESTED ? "true" : "false");
  fprintf(out, ",\"gpuCompletionIdentityReported\":%s",
          run->gpu_attestation == GDPROBE_GPU_TIMESTAMP_RESOLVED ? "true" : "false");
  fprintf(out, ",\"hardwarePerformanceReported\":%s", run->performance_reported ? "true" : "false");
  fputs(",\"pixelVisualInspectionPerformed\":false,\"notes\":[", out);
  {
    size_t written = 0;
    char attestation[192];
    snprintf(attestation, sizeof attestation, "gpu attestation: %s",
             attestation_note(run->gpu_attestation));
    write_json_string(out, attestation);
    written += 1;
    if (run->device_name[0]) {
      char device[192];
      snprintf(device, sizeof device, "device: %s %s", run->device_name, run->driver_version);
      fputc(',', out);
      write_json_string(out, device);
      written += 1;
    }
    for (size_t n = 0; n < run->note_count; n += 1) {
      if (written) fputc(',', out);
      write_json_string(out, run->notes[n]);
      written += 1;
    }
  }
  fputs("]}}", out);

  int failed = fflush(out) != 0;
  if (fclose(out) != 0) failed = 1;
  if (failed) {
    set_error(run, "capture manifest was not fully written");
    return GDPROBE_ERR_IO;
  }
  free(run);
  return GDPROBE_OK;
}

void gdprobe_run_discard(gdprobe_run *run) {
  if (!run) return;
  if (run->telemetry) fclose(run->telemetry);
  free(run);
}
