import { describe, expect, it } from "bun:test";
import { togglePictureInPicture } from "../src/lib/pictureInPicture";

function fixture() {
  const calls: string[] = [];
  const doc = {
    pictureInPictureElement: null as Element | null,
    exitPictureInPicture: async () => {
      calls.push("standard exit");
    },
  };
  const video = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    webkitPresentationMode: "inline",
    webkitSupportsPresentationMode: () => true,
    webkitSetPresentationMode: (mode: string) => {
      calls.push(mode);
      video.webkitPresentationMode = mode;
      video.dispatchEvent(new Event("webkitpresentationmodechanged"));
    },
    requestPictureInPicture: async () => {
      calls.push("standard enter");
    },
  });
  return { video, element: video as unknown as HTMLVideoElement, doc, calls };
}

describe("picture-in-picture", () => {
  it("reopens after native close even while the document still identifies the old PiP element", async () => {
    const { video, element, doc, calls } = fixture();
    await togglePictureInPicture(element);
    doc.pictureInPictureElement = element;
    video.webkitPresentationMode = "inline";
    await togglePictureInPicture(element);
    await togglePictureInPicture(element);
    expect(calls).toEqual(["picture-in-picture", "picture-in-picture", "inline"]);
  });

  it("allows exit even if support is no longer reported", async () => {
    const { video, element, calls } = fixture();
    video.webkitPresentationMode = "picture-in-picture";
    video.webkitSupportsPresentationMode = () => false;
    await togglePictureInPicture(element);
    expect(calls).toEqual(["inline"]);
  });

  it("reports unsupported video and native failures", async () => {
    const { video, element } = fixture();
    video.webkitSupportsPresentationMode = () => false;
    await expect(togglePictureInPicture(element)).rejects.toThrow("unavailable");
    video.webkitSupportsPresentationMode = () => true;
    video.webkitSetPresentationMode = () => {
      throw new Error("Native failure");
    };
    await expect(togglePictureInPicture(element)).rejects.toThrow("Native failure");
  });

  it("uses the standard API on other engines and targets this video", async () => {
    const { video, element, doc, calls } = fixture();
    Reflect.deleteProperty(video, "webkitPresentationMode");
    doc.pictureInPictureElement = {} as Element;
    await togglePictureInPicture(element);
    doc.pictureInPictureElement = element;
    await togglePictureInPicture(element);
    expect(calls).toEqual(["standard enter", "standard exit"]);
  });
});
