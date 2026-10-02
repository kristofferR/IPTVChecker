/**
 * Actual SF Symbol icons from @bradleyhodges/sfsymbols.
 *
 * Each component is a thin wrapper that renders the real SF Symbol SVG path data
 * with a Lucide-compatible `ComponentProps<"svg">` interface for drop-in use.
 */

import {
  sfCheckmarkCircleFill,
  sfChevronDown,
  sfClockArrowTriangleheadCounterclockwiseRotate90,
  sfDocumentOnDocumentFill,
  sfDocumentViewfinder,
  sfFolder,
  sfGearshape,
  sfLink,
  sfListNumber,
  sfLockFill,
  sfPauseFill,
  sfPhotoFill,
  sfPlayFill,
  sfScanner,
  sfShieldFill,
  sfSquareAndArrowUp,
  sfStopFill,
  sfTagFill,
  sfXmarkCircleFill,
} from "@bradleyhodges/sfsymbols";
import type { ComponentProps } from "react";

type IconProps = ComponentProps<"svg">;

interface SFIconDef {
  viewBox: string;
  svgPathData: { d: string; fillOpacity?: number }[];
  style?: string | null;
}

function makeSFIcon(icon: SFIconDef) {
  return function SFIconComponent(props: IconProps) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox={icon.viewBox} fill="currentColor" {...props}>
        {icon.svgPathData.map((path, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed path list per icon; never reorders, children hold no state.
            key={i}
            d={path.d}
            fillOpacity={path.fillOpacity}
          />
        ))}
      </svg>
    );
  };
}

export const SFPlayFill = makeSFIcon(sfPlayFill);
export const SFPauseFill = makeSFIcon(sfPauseFill);
export const SFStopFill = makeSFIcon(sfStopFill);
export const SFFolder = makeSFIcon(sfFolder);

export const SFLink = makeSFIcon(sfLink);
export const SFGearshape = makeSFIcon(sfGearshape);
export const SFClockArrow = makeSFIcon(sfClockArrowTriangleheadCounterclockwiseRotate90);
export const SFSquareArrowUp = makeSFIcon(sfSquareAndArrowUp);
export const SFCheckmarkCircleFill = makeSFIcon(sfCheckmarkCircleFill);
export const SFXmarkCircleFill = makeSFIcon(sfXmarkCircleFill);
export const SFLockFill = makeSFIcon(sfLockFill);
export const SFShieldFill = makeSFIcon(sfShieldFill);
export const SFListNumber = makeSFIcon(sfListNumber);
// exclamationmark.triangle.fill is missing from @bradleyhodges/sfsymbols 8, so
// its path data is copied from 7.0.4.
export const SFExclamationTriangleFill = makeSFIcon({
  viewBox: "0 0 20.83 18.662",
  svgPathData: [
    {
      d: "m12.51 1.338 7.578 13.203c.244.43.38.908.38 1.367 0 1.494-1.005 2.647-2.665 2.647H2.666C1.006 18.555 0 17.402 0 15.908c0-.459.117-.928.38-1.367L7.96 1.338A2.58 2.58 0 0 1 10.234 0c.899 0 1.768.45 2.276 1.338m-3.36 12.92c0 .576.508 1.045 1.094 1.045.576 0 1.084-.46 1.084-1.045 0-.596-.498-1.055-1.084-1.055-.596 0-1.094.469-1.094 1.055m.166-8.35.127 5.313c.01.517.293.81.801.81.479 0 .762-.283.772-.81l.146-5.303c.01-.518-.4-.898-.928-.898-.546 0-.927.37-.918.888",
      fillOpacity: 0.85,
    },
  ],
});
export const SFDocOnDocFill = makeSFIcon(sfDocumentOnDocumentFill);
export const SFTagFill = makeSFIcon(sfTagFill);
export const SFChevronDown = makeSFIcon(sfChevronDown);
export const SFDocumentViewfinder = makeSFIcon(sfDocumentViewfinder);
export const SFPhotoFill = makeSFIcon(sfPhotoFill);
export const SFScanner = makeSFIcon(sfScanner);
