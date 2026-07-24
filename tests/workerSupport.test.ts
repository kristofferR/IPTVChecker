import { describe, expect, it } from "bun:test";
import { probeBlobWorkerSupport } from "../src/lib/workerSupport";

type Listener = EventListener;

function createProbeWorker(outcome: "ready" | "error") {
  const listeners = new Map<"message" | "error", Listener>();
  let terminated = false;

  const worker = {
    addEventListener(type: "message" | "error", listener: Listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: "message" | "error", listener: Listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    terminate() {
      terminated = true;
    },
  };

  queueMicrotask(() => {
    listeners.get(outcome === "ready" ? "message" : "error")?.(new Event(outcome));
  });

  return {
    worker,
    wasTerminated: () => terminated,
  };
}

describe("blob worker support probe", () => {
  it("accepts a worker only after its script responds", async () => {
    const probe = createProbeWorker("ready");
    let revokedUrl: string | null = null;

    const supported = await probeBlobWorkerSupport({
      createWorker: () => probe.worker,
      createObjectUrl: () => "blob:test-worker",
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      timeoutMs: 100,
    });

    expect(supported).toBe(true);
    expect(probe.wasTerminated()).toBe(true);
    expect(revokedUrl).toBe("blob:test-worker");
  });

  it("falls back when CSP or the browser rejects the worker script", async () => {
    const probe = createProbeWorker("error");

    const supported = await probeBlobWorkerSupport({
      createWorker: () => probe.worker,
      createObjectUrl: () => "blob:blocked-worker",
      revokeObjectUrl: () => {},
      timeoutMs: 100,
    });

    expect(supported).toBe(false);
    expect(probe.wasTerminated()).toBe(true);
  });

  it("falls back when worker construction fails synchronously", async () => {
    const supported = await probeBlobWorkerSupport({
      createWorker: () => {
        throw new Error("workers unavailable");
      },
      createObjectUrl: () => "blob:failed-worker",
      revokeObjectUrl: () => {},
      timeoutMs: 100,
    });

    expect(supported).toBe(false);
  });
});
