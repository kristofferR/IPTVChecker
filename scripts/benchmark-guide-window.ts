import { guideProgrammesInWindow, indexGuideProgrammes } from "../src/lib/guideProgrammes";
import type { EpgProgramme } from "../src/lib/types";

// 60 mounted rows, each with 14 days of 15-minute programmes. Compare the
// same visible listings over 120 horizontal windows, including index setup.
const rows = Array.from({ length: 60 }, (_, row) =>
  Array.from({ length: 14 * 96 }, (_, slot) => ({
    start: slot * 900,
    stop: (slot + 1) * 900,
    title: `Channel ${row}, programme ${slot}`,
  })),
);
const windows = Array.from({ length: 120 }, (_, i) => ({
  from: (10 * 24 + i / 2) * 3600,
  to: (10 * 24 + i / 2 + 10) * 3600,
}));

function measure(label: string, run: () => number): number {
  const samples: number[] = [];
  let visible = 0;
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    visible = run();
    if (i >= 3) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${label}: median=${samples[4].toFixed(2)}ms, visible=${visible}`);
  return visible;
}

const before = measure("Full history scan", () => {
  let visible = 0;
  for (const { from, to } of windows) {
    for (const programmes of rows) {
      // Same predicate as the original render loop, collecting only matches.
      const selected: EpgProgramme[] = programmes.filter(
        (programme) => !(programme.stop < from || programme.start > to),
      );
      visible += selected.length;
    }
  }
  return visible;
});
const after = measure("Indexed window (including setup)", () => {
  const indices = rows.map(indexGuideProgrammes);
  let visible = 0;
  for (const { from, to } of windows) {
    for (const index of indices) visible += guideProgrammesInWindow(index, from, to).length;
  }
  return visible;
});
if (before !== after) throw new Error("Window selection changed the visible programme count");
