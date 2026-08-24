/**
 * Normalized job lifecycle.
 *
 * Providers each have their own status vocabulary. We map them onto one set of
 * states so an agent can reason about progress without knowing which provider
 * is behind a job, and keep the provider's raw status alongside so nothing is
 * lost in translation.
 */

export const ASSET_JOB_STATUSES = [
  'queued',
  'generating_reference',
  'reference_ready',
  'generating_3d',
  'processing',
  'ready',
  'failed',
  'cancelled',
] as const;

export type AssetJobStatus = (typeof ASSET_JOB_STATUSES)[number];

/** States from which no further transition happens. */
const TERMINAL: ReadonlySet<AssetJobStatus> = new Set<AssetJobStatus>(['ready', 'failed', 'cancelled']);

export function isTerminal(status: AssetJobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Legal transitions. Deliberately strict: an illegal transition is a bug in our
 * state handling, and silently allowing it would let a job report `ready`
 * without ever having produced a model.
 */
const ALLOWED: Record<AssetJobStatus, readonly AssetJobStatus[]> = {
  queued: ['generating_reference', 'generating_3d', 'processing', 'failed', 'cancelled'],
  generating_reference: ['reference_ready', 'failed', 'cancelled'],
  reference_ready: ['generating_3d', 'failed', 'cancelled'],
  generating_3d: ['processing', 'ready', 'failed', 'cancelled'],
  processing: ['ready', 'failed', 'cancelled'],
  ready: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: AssetJobStatus, to: AssetJobStatus): boolean {
  // A terminal state cannot even re-enter itself: re-applying `ready` would
  // invite a late poll to overwrite a finished job's payload.
  if (from === to) return !isTerminal(from);
  return ALLOWED[from].includes(to);
}

/**
 * Map a Tripo task status onto our vocabulary.
 *
 * Tripo reports: queued | running | success | failed | cancelled | banned |
 * unknown. `banned` is a moderation refusal — terminal, and distinct enough
 * that the reason is preserved in the job's error field by the caller.
 */
export function fromTripoStatus(raw: string): AssetJobStatus {
  // Case-folded because a provider changing "success" to "Success" must not
  // silently become an unrecognised status.
  switch (raw.trim().toLowerCase()) {
    case 'success':
      return 'ready';
    case 'failed':
    case 'banned':
    case 'unknown':
    case 'expired':
    case 'timeout':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'queued':
    case 'pending':
      return 'generating_3d';
    case 'running':
    case 'processing':
      return 'processing';
    default:
      // FAIL LOUD. Defaulting to a non-terminal state would turn any unknown
      // status into an infinite poll — a hang is far harder to diagnose than a
      // failure that names the status it did not recognise.
      return 'failed';
  }
}

/**
 * Map a Leonardo generation status onto our vocabulary.
 * Leonardo reports: PENDING | COMPLETE | FAILED.
 */
export function fromLeonardoStatus(raw: string): AssetJobStatus {
  switch (raw.toUpperCase()) {
    case 'COMPLETE':
      return 'reference_ready';
    case 'FAILED':
      return 'failed';
    default:
      return 'generating_reference';
  }
}
