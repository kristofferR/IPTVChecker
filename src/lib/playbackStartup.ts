/** Keep a route in startup until it actually presents media. `canplay` can
 * precede WebKit's first decode error, particularly for interlaced MPEG-TS. */
export function confirmPlaybackStarted(
  video: HTMLVideoElement,
  audioOnly: boolean | (() => boolean),
  onStarted: () => void,
  onFailure: (reason: string) => void,
): () => void {
  let closed = false;
  let frame: number | null = null;
  const isAudioOnly = () => (typeof audioOnly === "function" ? audioOnly() : audioOnly);
  const initialTime = video.currentTime;
  const initialQuality = video.getVideoPlaybackQuality?.();
  const initialPresented = initialQuality
    ? initialQuality.totalVideoFrames - initialQuality.droppedVideoFrames
    : 0;
  const started = () => {
    if (!closed && !video.paused && !video.error) onStarted();
  };
  const observeFrame = () => {
    frame = video.requestVideoFrameCallback(() => {
      if (closed) return;
      if (!video.paused) started();
      else observeFrame();
    });
  };
  if (!isAudioOnly() && typeof video.requestVideoFrameCallback === "function") observeFrame();
  const timer = setInterval(() => {
    if (closed) return;
    if (!isAudioOnly() && frame === null && typeof video.requestVideoFrameCallback === "function") {
      observeFrame();
    }
    if (video.currentTime <= initialTime || video.paused) return;
    const quality = video.getVideoPlaybackQuality?.();
    if (
      isAudioOnly() ||
      (video.videoWidth > 0 &&
        (document.visibilityState === "hidden" ||
          (quality
            ? quality.totalVideoFrames - quality.droppedVideoFrames > initialPresented
            : !video.requestVideoFrameCallback)))
    )
      started();
  }, 100);
  void video.play().catch((error: unknown) => {
    if (!closed) onFailure(error instanceof Error ? error.message : "Could not start playback");
  });
  return () => {
    closed = true;
    clearInterval(timer);
    if (frame !== null) video.cancelVideoFrameCallback(frame);
  };
}
