/**
 * Actual SF Symbol icons from @bradleyhodges/sfsymbols.
 *
 * Each component is a thin wrapper that renders the real SF Symbol SVG path data
 * with a Lucide-compatible `ComponentProps<"svg">` interface for drop-in use.
 */
import type { ComponentProps } from "react";
import {
  sfPlayFill,
  sfPauseFill,
  sfStopFill,
  sfFolder,

  sfLink,
  sfGearshape,
  sfClockArrowTriangleheadCounterclockwiseRotate90,
  sfSquareAndArrowUp,
  sfCheckmarkCircleFill,
  sfXmarkCircleFill,
  sfLockFill,
  sfShieldFill,
  sfListNumber,
  sfExclamationmarkTriangleFill,
  sfDocumentOnDocumentFill,
  sfTagFill,
  sfChevronDown,
  sfDocumentViewfinder,
} from "@bradleyhodges/sfsymbols";

type IconProps = ComponentProps<"svg">;

interface SFIconDef {
  viewBox: string;
  svgPathData: { d: string; fillOpacity?: number }[];
  style?: string | null;
}

function makeSFIcon(icon: SFIconDef) {
  return function SFIconComponent(props: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={icon.viewBox}
        fill="currentColor"
        {...props}
      >
        {icon.svgPathData.map((path, i) => (
          <path
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
export const SFClockArrow = makeSFIcon(
  sfClockArrowTriangleheadCounterclockwiseRotate90,
);
export const SFSquareArrowUp = makeSFIcon(sfSquareAndArrowUp);
export const SFCheckmarkCircleFill = makeSFIcon(sfCheckmarkCircleFill);
export const SFXmarkCircleFill = makeSFIcon(sfXmarkCircleFill);
export const SFLockFill = makeSFIcon(sfLockFill);
export const SFShieldFill = makeSFIcon(sfShieldFill);
export const SFListNumber = makeSFIcon(sfListNumber);
export const SFExclamationTriangleFill = makeSFIcon(
  sfExclamationmarkTriangleFill,
);
export const SFDocOnDocFill = makeSFIcon(sfDocumentOnDocumentFill);
export const SFTagFill = makeSFIcon(sfTagFill);
export const SFChevronDown = makeSFIcon(sfChevronDown);
export const SFDocumentViewfinder = makeSFIcon(sfDocumentViewfinder);
