import { randomUUID } from 'node:crypto';
import { GAME_DEV_EVENT_SCHEMA } from '../version.js';

export type GameDevEventType =
  | 'started'
  | 'progress'
  | 'artifact'
  | 'warning'
  | 'approval_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GameDevEvent {
  schema: typeof GAME_DEV_EVENT_SCHEMA;
  event_id: string;
  job_id: string;
  sequence: number;
  timestamp: string;
  type: GameDevEventType;
  operation: string;
  data: Record<string, unknown>;
}

export class EventStream {
  readonly jobId: string;
  private sequence = 0;

  constructor(
    private readonly operation: string,
    private readonly enabled: boolean,
    jobId?: string,
    private readonly sink?: (event: GameDevEvent) => void,
  ) {
    this.jobId = jobId ?? `job_${randomUUID()}`;
  }

  emit(type: GameDevEventType, data: Record<string, unknown> = {}): GameDevEvent {
    const event: GameDevEvent = {
      schema: GAME_DEV_EVENT_SCHEMA,
      event_id: `evt_${randomUUID()}`,
      job_id: this.jobId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      type,
      operation: this.operation,
      data,
    };
    this.sequence += 1;
    this.sink?.(event);
    if (this.enabled) process.stdout.write(`${JSON.stringify(event)}\n`);
    return event;
  }

  replay(event: Record<string, unknown>): void {
    if (this.enabled) process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}
