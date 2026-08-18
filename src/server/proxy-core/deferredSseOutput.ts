export const PRE_OUTPUT_RETRY_GRACE_MS = 250;

export function createDeferredSseOutput(input: {
  start: () => void;
  write: (chunk: string) => void;
  end: () => void;
  maxDelayMs?: number;
}) {
  const bufferedChunks: string[] = [];
  let committed = false;
  let endRequested = false;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCommitTimer = () => {
    if (!commitTimer) return;
    clearTimeout(commitTimer);
    commitTimer = null;
  };

  const commit = () => {
    if (committed) return;
    clearCommitTimer();
    input.start();
    committed = true;
    for (const chunk of bufferedChunks.splice(0)) {
      input.write(chunk);
    }
    if (endRequested) {
      input.end();
    }
  };

  const output = {
    get committed() {
      return committed;
    },
    write(chunk: string) {
      if (committed) {
        input.write(chunk);
        return;
      }
      bufferedChunks.push(chunk);
    },
    end() {
      if (committed) {
        input.end();
        return;
      }
      endRequested = true;
    },
    commit,
    cancelAutoCommit: clearCommitTimer,
    discard() {
      if (committed) return;
      clearCommitTimer();
      bufferedChunks.length = 0;
      endRequested = false;
    },
  };

  if ((input.maxDelayMs || 0) > 0) {
    commitTimer = setTimeout(commit, input.maxDelayMs);
    commitTimer.unref?.();
  }

  return output;
}
