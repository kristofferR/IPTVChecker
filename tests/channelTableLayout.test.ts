import {
  getChannelTableLayout,
  INLINE_TABLE_HEADER_HEIGHT_PX,
} from "../src/lib/channelTableLayout";

describe("channel table layout", () => {
  test("inline header layouts keep the scroll container below the header", () => {
    expect(
      getChannelTableLayout({
        hasPortaledHeader: false,
      }),
    ).toEqual({
      scrollContainerTop: INLINE_TABLE_HEADER_HEIGHT_PX,
    });
  });

  test("portaled header layouts let the scroll container start at the top", () => {
    expect(
      getChannelTableLayout({
        hasPortaledHeader: true,
      }),
    ).toEqual({
      scrollContainerTop: 0,
    });
  });
});
