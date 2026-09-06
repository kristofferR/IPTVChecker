import { Radio, Tv } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { extractTvgLogoUrl, normalizeTvgLogoUrl } from "../lib/extinf";
import { useLogoCacheStatus } from "../lib/logoCache";
import type { ChannelResult } from "../lib/types";

interface ChannelLogoProps {
  result: Pick<ChannelResult, "name" | "tvg_logo" | "extinf_line" | "audio_only">;
  size: number;
}

export const ChannelLogo = memo(function ChannelLogo({ result, size }: ChannelLogoProps) {
  const logoUrl = useMemo(
    () => normalizeTvgLogoUrl(result.tvg_logo) ?? extractTvgLogoUrl(result.extinf_line),
    [result.extinf_line, result.tvg_logo],
  );
  const logoStatus = useLogoCacheStatus(logoUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const frameClass =
    "grid shrink-0 place-items-center rounded-sm ring-1 ring-border-subtle bg-panel-subtle";
  const style = { width: size, height: size };

  if (logoUrl && failedUrl !== logoUrl && logoStatus === "ready") {
    return (
      <img
        src={logoUrl}
        alt={`${result.name} logo`}
        className={`${frameClass} object-contain`}
        style={style}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(logoUrl)}
      />
    );
  }

  const KindIcon = result.audio_only ? Radio : Tv;
  const kindLabel = result.audio_only ? "Audio-only stream" : "Video stream";
  return (
    <span
      className={`${frameClass} ${result.audio_only ? "text-cyan-400" : "text-text-tertiary"}`}
      aria-label={kindLabel}
      title={kindLabel}
      style={style}
    >
      <KindIcon size={Math.max(12, Math.round(size * 0.68))} aria-hidden="true" />
    </span>
  );
});
