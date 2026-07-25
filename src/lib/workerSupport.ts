interface WorkerProbe {
  addEventListener(
    type: "message" | "error",
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: "message" | "error", listener: EventListener): void;
  terminate(): void;
}

interface BlobWorkerProbeOptions {
  createWorker?: (url: string) => WorkerProbe;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * Verify that a blob-backed worker can actually run, not merely be constructed.
 * CSP violations are reported asynchronously, which otherwise leaves mpegts.js
 * waiting on a worker that will never start or request the stream.
 */
export function probeBlobWorkerSupport(options: BlobWorkerProbeOptions = {}): Promise<boolean> {
  const {
    createWorker = (url) => new Worker(url),
    createObjectUrl = (blob) => URL.createObjectURL(blob),
    revokeObjectUrl = (url) => URL.revokeObjectURL(url),
    timeoutMs = 1_000,
  } = options;

  if (
    options.createWorker == null &&
    (typeof Worker === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL.createObjectURL !== "function")
  ) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let worker: WorkerProbe | null = null;
    let objectUrl: string | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      worker?.removeEventListener("message", onReady);
      worker?.removeEventListener("error", onError);
      worker?.terminate();
      if (objectUrl !== null) revokeObjectUrl(objectUrl);
      resolve(supported);
    };
    const onReady: EventListener = () => finish(true);
    const onError: EventListener = () => finish(false);

    try {
      const script = new Blob(['self.postMessage("ready");'], {
        type: "text/javascript",
      });
      objectUrl = createObjectUrl(script);
      worker = createWorker(objectUrl);
      worker.addEventListener("message", onReady, { once: true });
      worker.addEventListener("error", onError, { once: true });
      timer = setTimeout(() => finish(false), timeoutMs);
    } catch {
      finish(false);
    }
  });
}

let cachedBlobWorkerSupport: Promise<boolean> | null = null;

export function canUseBlobWorkers(): Promise<boolean> {
  cachedBlobWorkerSupport ??= probeBlobWorkerSupport();
  return cachedBlobWorkerSupport;
}
