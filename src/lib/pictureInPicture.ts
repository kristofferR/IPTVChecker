interface WebKitVideo extends HTMLVideoElement {
  webkitPresentationMode?: "inline" | "fullscreen" | "picture-in-picture";
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
}

export function supportsPictureInPicture(video: HTMLVideoElement): boolean {
  const native = video as WebKitVideo;
  return (
    video.ownerDocument.pictureInPictureEnabled ||
    typeof native.webkitSetPresentationMode === "function"
  );
}

export async function togglePictureInPicture(video: HTMLVideoElement): Promise<void> {
  const native = video as WebKitVideo;
  const doc = video.ownerDocument;
  if (native.webkitPresentationMode && native.webkitSetPresentationMode) {
    // The document-level PiP element can lag behind closing the native window.
    const mode =
      native.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture";
    if (mode === "picture-in-picture" && !native.webkitSupportsPresentationMode?.(mode)) {
      throw new Error("Picture-in-picture is unavailable for this video.");
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        video.removeEventListener("webkitpresentationmodechanged", changed);
        if (error) reject(error);
        else resolve();
      };
      const changed = () => {
        if (native.webkitPresentationMode === mode) finish();
      };
      const timer = setTimeout(
        () => finish(new Error("Picture-in-picture did not respond. Please try again.")),
        2000,
      );
      video.addEventListener("webkitpresentationmodechanged", changed);
      try {
        native.webkitSetPresentationMode?.(mode);
        changed();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return;
  }
  if (doc.pictureInPictureElement === video) {
    await doc.exitPictureInPicture();
  } else {
    await video.requestPictureInPicture();
  }
}
