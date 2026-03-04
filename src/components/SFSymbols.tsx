/**
 * SF Symbol–inspired icons for macOS toolbar.
 *
 * These match Apple's SF Symbols design language: filled action icons,
 * consistent visual weight, rounded corners, and proper optical sizing.
 * All icons use a 24×24 viewBox for drop-in compatibility with Lucide sizing.
 */
import type { ComponentProps } from "react";

type IconProps = ComponentProps<"svg">;

// SF Symbol: play.fill
export function SFPlayFill(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M7.73 5.02C7.04 4.59 6.15 5.09 6.15 5.9v12.2c0 .81.89 1.31 1.58.88l10.08-6.1a1.03 1.03 0 000-1.76L7.73 5.02z" />
    </svg>
  );
}

// SF Symbol: pause.fill
export function SFPauseFill(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <rect x="5.5" y="4.5" width="4.5" height="15" rx="1.25" />
      <rect x="14" y="4.5" width="4.5" height="15" rx="1.25" />
    </svg>
  );
}

// SF Symbol: stop.fill
export function SFStopFill(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />
    </svg>
  );
}

// SF Symbol: folder
export function SFFolder(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3.5 7.25V18a2.25 2.25 0 002.25 2.25h12.5A2.25 2.25 0 0020.5 18V9.75a2.25 2.25 0 00-2.25-2.25H12l-1.72-2.15a1.5 1.5 0 00-1.17-.56H5.75A2.25 2.25 0 003.5 7.04z" />
    </svg>
  );
}

// SF Symbol: folder.fill
export function SFFolderFill(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M3.5 7.25V18a2.25 2.25 0 002.25 2.25h12.5A2.25 2.25 0 0020.5 18V9.75a2.25 2.25 0 00-2.25-2.25H12l-1.72-2.15a1.5 1.5 0 00-1.17-.56H5.75A2.25 2.25 0 003.5 7.04z" />
    </svg>
  );
}

// SF Symbol: link
export function SFLink(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.5 13.5l3-3" />
      <path d="M14.83 13.17l1.77-1.77a3.5 3.5 0 00-4.95-4.95L9.88 8.22" />
      <path d="M9.17 10.83l-1.77 1.77a3.5 3.5 0 004.95 4.95l1.77-1.77" />
    </svg>
  );
}

// SF Symbol: gearshape
export function SFGearshape(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M13.7 2.5h-3.4l-.5 2.2a7.1 7.1 0 00-2.12 1.22l-2.1-.78-1.7 2.94 1.6 1.44a7.2 7.2 0 000 2.44l-1.6 1.44 1.7 2.94 2.1-.78c.62.5 1.33.92 2.12 1.22l.5 2.2h3.4l.5-2.2a7.1 7.1 0 002.12-1.22l2.1.78 1.7-2.94-1.6-1.44a7.2 7.2 0 000-2.44l1.6-1.44-1.7-2.94-2.1.78A7.1 7.1 0 0014.2 4.7l-.5-2.2z" />
    </svg>
  );
}

// SF Symbol: clock.arrow.circlepath
export function SFClockArrow(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3.34 13A8.8 8.8 0 103.58 9" />
      <polyline points="12 7 12 12.5 15.5 14.5" />
      <polyline points="1.5 12.5 3.5 13.5 4.5 11.5" />
    </svg>
  );
}

// SF Symbol: square.and.arrow.up
export function SFSquareArrowUp(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 10.5v8.25c0 .69.56 1.25 1.25 1.25h5.5c.69 0 1.25-.56 1.25-1.25V10.5" />
      <line x1="12" y1="15" x2="12" y2="3.5" />
      <polyline points="8.5 7 12 3.5 15.5 7" />
    </svg>
  );
}

// SF Symbol: chevron.down
export function SFChevronDown(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="7 9.5 12 14.5 17 9.5" />
    </svg>
  );
}
