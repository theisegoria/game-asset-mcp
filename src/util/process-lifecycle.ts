export type OwnedProcessSignal = 'SIGTERM' | 'SIGKILL';

type OwnedProcessTerminator = (signal: OwnedProcessSignal) => void;

const ownedProcessTerminators = new Set<OwnedProcessTerminator>();

export function registerOwnedProcessTerminator(
  terminate: OwnedProcessTerminator,
): () => void {
  ownedProcessTerminators.add(terminate);
  return () => ownedProcessTerminators.delete(terminate);
}

export function terminateOwnedProcesses(signal: OwnedProcessSignal): void {
  for (const terminate of [...ownedProcessTerminators]) {
    try {
      terminate(signal);
    } catch {
      // A process may have exited between registration and signal delivery.
    }
  }
}

export interface InstalledSignalHandlers {
  dispose(): void;
  requestedExitCode(): number | undefined;
}

export function installProcessSignalHandlers(
  controller: AbortController,
  hardExitAfterMs = 2_500,
): InstalledSignalHandlers {
  let receivedSignal: NodeJS.Signals | undefined;
  let hardExitTimer: NodeJS.Timeout | undefined;

  const exitCode = (signal: NodeJS.Signals): number => signal === 'SIGINT' ? 130 : 143;
  const handle = (signal: NodeJS.Signals): void => {
    if (receivedSignal) {
      terminateOwnedProcesses('SIGKILL');
      process.exit(exitCode(receivedSignal));
    }

    receivedSignal = signal;
    process.exitCode = exitCode(signal);
    controller.abort(new Error(`game-dev received ${signal}`));
    terminateOwnedProcesses('SIGTERM');
    hardExitTimer = setTimeout(() => {
      terminateOwnedProcesses('SIGKILL');
      process.exit(exitCode(signal));
    }, hardExitAfterMs);
    hardExitTimer.unref();
  };

  const onInterrupt = (): void => handle('SIGINT');
  const onTerminate = (): void => handle('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  return {
    dispose() {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (hardExitTimer) clearTimeout(hardExitTimer);
    },
    requestedExitCode() {
      return receivedSignal ? exitCode(receivedSignal) : undefined;
    },
  };
}
