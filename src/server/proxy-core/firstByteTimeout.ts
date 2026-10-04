import { Headers, Response } from 'undici';
import { AsyncLocalStorage } from 'node:async_hooks';

type FirstByteObservation = { pause(): void; resume(): void };
const observationScope = new AsyncLocalStorage<FirstByteObservation>();

/** Local admission waits are not time spent waiting for an upstream byte. */
export async function withoutFirstByteObservation<T>(operation: () => Promise<T>): Promise<T> {
  const observation = observationScope.getStore();
  observation?.pause();
  try { return await operation(); }
  finally { observation?.resume(); }
}

export type ObservedResponseMeta = {
  dispatchStartedAtMs: number;
  responseHeadersAtMs: number | null;
  firstByteAtMs: number | null;
  responseHeaderLatencyMs: number | null;
  firstByteLatencyMs: number | null;
  timedOutBeforeFirstByte: boolean;
};

const observedResponseMeta = new WeakMap<Response, ObservedResponseMeta>();

function setObservedResponseMeta<T extends Response>(response: T, meta: ObservedResponseMeta): T {
  observedResponseMeta.set(response, meta);
  return response;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (!timer) return;
  clearTimeout(timer);
}

function buildFirstByteTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `first byte timeout (${seconds}s)`;
}

function buildObservedTimeoutResponse(
  timeoutMs: number,
  input: {
    dispatchStartedAtMs: number;
    responseHeadersAtMs?: number | null;
    excludedWaitMs?: number;
  },
): Response {
  const responseHeadersAtMs = input.responseHeadersAtMs ?? null;
  return setObservedResponseMeta(new Response(buildFirstByteTimeoutMessage(timeoutMs), {
    status: 408,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  }), {
    dispatchStartedAtMs: input.dispatchStartedAtMs,
    responseHeadersAtMs,
    firstByteAtMs: null,
    responseHeaderLatencyMs: responseHeadersAtMs === null
      ? null
      : Math.max(0, responseHeadersAtMs - input.dispatchStartedAtMs - (input.excludedWaitMs ?? 0)),
    firstByteLatencyMs: null,
    timedOutBeforeFirstByte: true,
  });
}

async function cancelReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array> | null) {
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    // Ignore cancellation errors from already-closed streams.
  }
  try {
    reader.releaseLock();
  } catch {
    // Ignore release errors from already-released readers.
  }
}

function buildReplayResponse<T extends Response>(
  response: T,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstChunk: ReadableStreamReadResult<Uint8Array>,
): T {
  let firstChunkDelivered = false;
  let readerReleased = false;
  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures from cancelled/closed readers.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstChunkDelivered) {
        firstChunkDelivered = true;
        if (firstChunk.done) {
          controller.close();
          releaseReader();
          return;
        }
        controller.enqueue(firstChunk.value);
        return;
      }

      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          releaseReader();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        releaseReader();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Ignore cancellation failures from already-closed streams.
      }
      releaseReader();
    },
  }, { highWaterMark: 0 });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  }) as T;
}

export async function fetchWithObservedFirstByte<T extends Response>(
  dispatch: (signal?: AbortSignal) => Promise<T>,
  options: {
    firstByteTimeoutMs?: number;
    startedAtMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = Math.max(0, Math.trunc(options.firstByteTimeoutMs ?? 0));
  const startedAtMs = options.startedAtMs ?? Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOutBeforeFirstByte = false;
  let excludedWaitMs = 0;
  let pauseDepth = 0;
  let pausedAtMs = 0;
  let armedAtMs = Date.now();
  let remainingMs = timeoutMs;
  let finished = false;
  const timeoutSentinel = Symbol('first-byte-timeout');
  let resolveTimeout: (value: typeof timeoutSentinel) => void = () => {};
  const armTimer = () => {
    if (!timeoutMs || finished || timedOutBeforeFirstByte) return;
    armedAtMs = Date.now();
    timer = setTimeout(() => {
      timedOutBeforeFirstByte = true;
      controller?.abort(new Error(buildFirstByteTimeoutMessage(timeoutMs)));
      resolveTimeout(timeoutSentinel);
    }, remainingMs);
  };
  const timeoutPromise = timeoutMs > 0
    ? new Promise<typeof timeoutSentinel>((resolve) => {
      resolveTimeout = resolve;
      armTimer();
    })
    : null;
  const observation: FirstByteObservation = {
    pause() {
      if (finished || pauseDepth++ > 0) return;
      pausedAtMs = Date.now();
      remainingMs = Math.max(0, remainingMs - (pausedAtMs - armedAtMs));
      clearTimer(timer);
      timer = null;
    },
    resume() {
      if (finished || --pauseDepth > 0) return;
      excludedWaitMs += Date.now() - pausedAtMs;
      armTimer();
    },
  };

  try {
    const dispatchPromise = observationScope.run(observation, () => dispatch(controller?.signal));
    const dispatched = timeoutPromise
      ? await Promise.race([dispatchPromise, timeoutPromise])
      : await dispatchPromise;
    if (dispatched === timeoutSentinel) {
      return buildObservedTimeoutResponse(timeoutMs, {
        dispatchStartedAtMs: startedAtMs,
        excludedWaitMs,
      }) as T;
    }
    const response = dispatched as T;
    const responseHeadersAtMs = Date.now();
    if (!response.body) {
      clearTimer(timer);
      return setObservedResponseMeta(response, {
        dispatchStartedAtMs: startedAtMs,
        responseHeadersAtMs,
        firstByteAtMs: responseHeadersAtMs,
        responseHeaderLatencyMs: Math.max(0, responseHeadersAtMs - startedAtMs - excludedWaitMs),
        firstByteLatencyMs: Math.max(0, responseHeadersAtMs - startedAtMs - excludedWaitMs),
        timedOutBeforeFirstByte: false,
      });
    }

    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const firstChunk = timeoutPromise
      ? await Promise.race([reader.read(), timeoutPromise])
      : await reader.read();
    if (firstChunk === timeoutSentinel) {
      await cancelReaderQuietly(reader);
      return buildObservedTimeoutResponse(timeoutMs, {
        dispatchStartedAtMs: startedAtMs,
        responseHeadersAtMs,
        excludedWaitMs,
      }) as T;
    }
    clearTimer(timer);
    const firstByteAtMs = Date.now();
    return setObservedResponseMeta(buildReplayResponse(response, reader, firstChunk), {
      dispatchStartedAtMs: startedAtMs,
      responseHeadersAtMs,
      firstByteAtMs,
      responseHeaderLatencyMs: Math.max(0, responseHeadersAtMs - startedAtMs - excludedWaitMs),
      firstByteLatencyMs: Math.max(0, firstByteAtMs - startedAtMs - excludedWaitMs),
      timedOutBeforeFirstByte: false,
    });
  } catch (error) {
    clearTimer(timer);
    if (timedOutBeforeFirstByte && timeoutMs > 0) {
      return buildObservedTimeoutResponse(timeoutMs, {
        dispatchStartedAtMs: startedAtMs,
        excludedWaitMs,
      }) as T;
    }
    throw error;
  } finally {
    finished = true;
    clearTimer(timer);
  }
}

export function getObservedResponseMeta(response: Response | null | undefined): ObservedResponseMeta | null {
  if (!response) return null;
  return observedResponseMeta.get(response) ?? null;
}

export function isObservedFirstByteTimeoutResponse(response: Response | null | undefined): boolean {
  return getObservedResponseMeta(response)?.timedOutBeforeFirstByte === true;
}
