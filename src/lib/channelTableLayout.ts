export const INLINE_TABLE_HEADER_HEIGHT_PX = 32;

interface ChannelTableLayoutInput {
  hasPortaledHeader: boolean;
}

interface ChannelTableLayout {
  scrollContainerTop: number;
}

export function getChannelTableLayout({
  hasPortaledHeader,
}: ChannelTableLayoutInput): ChannelTableLayout {
  return {
    scrollContainerTop: hasPortaledHeader ? 0 : INLINE_TABLE_HEADER_HEIGHT_PX,
  };
}
