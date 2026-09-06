let dayFormatter: Intl.DateTimeFormat | undefined;
let timeFormatter: Intl.DateTimeFormat | undefined;

// Format local wall-clock values in UTC so cached formatters never retain an
// old system time zone. Date's offset follows zone changes and the input's DST.
function localWallClockEpochMs(date: Date): number {
  return date.getTime() - date.getTimezoneOffset() * 60_000;
}

/** "Today", "Yesterday", or a short local date like "Wed 28 Aug". */
export function dayLabel(epochS: number, now: Date = new Date()): string {
  const date = new Date(epochS * 1000);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  dayFormatter ??= new Intl.DateTimeFormat([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return dayFormatter.format(localWallClockEpochMs(date));
}

/** Local wall-clock time like "21:00". */
export function timeLabel(epochS: number): string {
  // Guide rows format hundreds of labels while scrolling. Reuse the locale
  // formatter rather than constructing one for each programme.
  timeFormatter ??= new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
  return timeFormatter.format(localWallClockEpochMs(new Date(epochS * 1000)));
}

/** Local midnight of the day `daysAgo` days before now, in epoch seconds. */
export function startOfDayEpochS(daysAgo: number, now: Date = new Date()): number {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
  return Math.floor(date.getTime() / 1000);
}
