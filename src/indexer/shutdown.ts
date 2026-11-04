// Global shutdown flag. Kept out of worker.ts so modules can check it without
// importing worker.ts, which starts the worker as soon as it is loaded.
let isShuttingDown = false;

export function isShutdownRequested(): boolean {
  return isShuttingDown;
}

export function requestShutdown(): void {
  isShuttingDown = true;
}
