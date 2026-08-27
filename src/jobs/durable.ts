import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import path from 'node:path';
import { invalidInput, invalidState, notFound } from '../util/errors.js';
import { redact } from '../util/logging.js';

export const DURABLE_JOB_SCHEMA = 'game_dev.job.v1';

export type DurableJobStatus =
  | 'queued'
  | 'running'
  | 'approval_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DurableArtifact {
  path: string;
  kind: string;
  sha256?: string;
  bytes?: number;
}

export interface DurableJob {
  schema: typeof DURABLE_JOB_SCHEMA;
  id: string;
  operation: string;
  status: DurableJobStatus;
  request: Record<string, unknown>;
  attempts: number;
  eventCount: number;
  artifacts: DurableArtifact[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: Record<string, unknown>;
  receiptPath?: string;
  parentJobId?: string;
  supersededByJobId?: string;
  approval?: Record<string, unknown>;
}

const JOB_ID = /^job_[0-9a-f-]{36}$/;

async function atomicJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${randomBytes(8).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export class DurableJobStore {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<DurableJobStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new DurableJobStore(root);
  }

  private directory(id: string): string {
    if (!JOB_ID.test(id)) throw invalidInput(`malformed durable job id: ${id}`);
    return path.join(this.root, id);
  }

  private jobPath(id: string): string {
    return path.join(this.directory(id), 'job.json');
  }

  eventsPath(id: string): string {
    return path.join(this.directory(id), 'events.jsonl');
  }

  async create(
    operation: string,
    request: Record<string, unknown>,
    options: { parentJobId?: string } = {},
  ): Promise<DurableJob> {
    if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(operation)) {
      throw invalidInput(`invalid durable operation: ${operation}`);
    }
    const id = `job_${randomUUID()}`;
    const dir = this.directory(id);
    await fs.mkdir(dir, { recursive: false, mode: 0o700 });
    const timestamp = new Date().toISOString();
    const job: DurableJob = {
      schema: DURABLE_JOB_SCHEMA,
      id,
      operation,
      status: 'queued',
      request: redact(request) as Record<string, unknown>,
      attempts: 0,
      eventCount: 0,
      artifacts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    };
    await atomicJson(this.jobPath(id), job);
    await fs.writeFile(this.eventsPath(id), '', { flag: 'wx', mode: 0o600 });
    return job;
  }

  async get(id: string): Promise<DurableJob> {
    let raw: string;
    try {
      raw = await fs.readFile(this.jobPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('durable job', id);
      throw error;
    }
    let job: unknown;
    try {
      job = JSON.parse(raw);
    } catch (error) {
      throw invalidState(`durable job ${id} is corrupt`, { reason: String(error) });
    }
    if (!job || typeof job !== 'object' || (job as Partial<DurableJob>).schema !== DURABLE_JOB_SCHEMA) {
      throw invalidState(`durable job ${id} has an unsupported schema`);
    }
    const parsed = job as DurableJob;
    try {
      const events = await fs.readFile(this.eventsPath(id), 'utf8');
      parsed.eventCount = events.length === 0
        ? 0
        : events.split('\n').reduce((count, line) => count + (line.length > 0 ? 1 : 0), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return parsed;
  }

  async save(job: DurableJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await atomicJson(this.jobPath(job.id), job);
  }

  /**
   * Append and fsync one event. Synchronous I/O is deliberate: a process crash
   * after stdout reported progress must not leave the durable stream behind.
   */
  appendEvent(id: string, event: Record<string, unknown>): void {
    const target = this.eventsPath(id);
    const descriptor = openSync(target, 'a', 0o600);
    try {
      appendFileSync(descriptor, `${JSON.stringify(redact(event))}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  async readEvents(
    id: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const afterSequence = options.afterSequence ?? -1;
    const limit = options.limit ?? 10_000;
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      throw invalidInput('afterSequence must be an integer greater than or equal to -1');
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100_000) {
      throw invalidInput('event limit must be an integer from 1 through 100000');
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.eventsPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('durable job', id);
      throw error;
    }
    const events: Record<string, unknown>[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw invalidState(`durable job ${id} has a corrupt event stream`, {
          reason: String(error),
        });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw invalidState(`durable job ${id} has a non-object event`);
      }
      const event = parsed as Record<string, unknown>;
      const sequence = event.sequence;
      if (typeof sequence === 'number' && sequence > afterSequence) events.push(event);
      if (events.length >= limit) break;
    }
    return events;
  }

  async markRunning(id: string): Promise<DurableJob> {
    const job = await this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      throw invalidState(`terminal durable job ${id} cannot run again`);
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.completedAt = undefined;
    job.error = undefined;
    job.approval = undefined;
    job.attempts += 1;
    await this.save(job);
    return job;
  }

  async markApprovalRequired(
    id: string,
    approval: Record<string, unknown>,
  ): Promise<DurableJob> {
    const job = await this.get(id);
    if (['completed', 'cancelled'].includes(job.status)) {
      throw invalidState(`terminal durable job ${id} cannot request approval`);
    }
    job.status = 'approval_required';
    job.approval = redact(approval) as Record<string, unknown>;
    job.error = undefined;
    await this.save(job);
    return job;
  }

  async cancel(id: string, reason = 'Local orchestration was cancelled. External work may continue.'): Promise<DurableJob> {
    const job = await this.get(id);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      job.error = { error: 'LOCALLY_CANCELLED', message: reason };
      await this.save(job);
    }
    return job;
  }

  async list(limit = 100): Promise<DurableJob[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const jobs: DurableJob[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      try {
        jobs.push(await this.get(entry.name));
      } catch {
        // A corrupt record is not silently promoted into the list. `get` still
        // exposes the exact failure for a caller investigating that id.
      }
    }
    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return jobs.slice(0, limit);
  }

  async complete(
    id: string,
    receipt: Record<string, unknown>,
    artifacts: DurableArtifact[] = [],
  ): Promise<DurableJob> {
    const job = await this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      throw invalidState(`terminal durable job ${id} cannot be completed again`);
    }
    const receiptPath = path.join(this.directory(id), 'receipt.json');
    await atomicJson(receiptPath, redact(receipt));
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.receiptPath = receiptPath;
    job.artifacts = artifacts;
    await this.save(job);
    return job;
  }

  async fail(id: string, error: Record<string, unknown>): Promise<DurableJob> {
    const job = await this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = redact(error) as Record<string, unknown>;
    await this.save(job);
    return job;
  }
}
