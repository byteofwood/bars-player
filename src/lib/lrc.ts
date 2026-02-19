export interface LyricLine {
  timeMs: number;
  text: string;
}

const TIMESTAMP_REGEX = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

function parseTimestampMs(match: RegExpExecArray): number {
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ?? "0";
  const millis = Number(fraction.padEnd(3, "0"));
  return minutes * 60000 + seconds * 1000 + millis;
}

export function parseLrc(text: string): LyricLine[] {
  const lines = text.split(/\r?\n/);
  const parsed: LyricLine[] = [];

  for (const line of lines) {
    TIMESTAMP_REGEX.lastIndex = 0;
    const timestamps: number[] = [];
    let match = TIMESTAMP_REGEX.exec(line);
    while (match) {
      timestamps.push(parseTimestampMs(match));
      match = TIMESTAMP_REGEX.exec(line);
    }

    if (timestamps.length === 0) {
      continue;
    }

    const lyricText = line.replace(TIMESTAMP_REGEX, "").trim();
    for (const timeMs of timestamps) {
      parsed.push({ timeMs, text: lyricText || "..." });
    }
  }

  return parsed.sort((a, b) => a.timeMs - b.timeMs);
}

export function activeLyricIndex(lines: LyricLine[], currentMs: number): number {
  if (lines.length === 0) {
    return -1;
  }

  let left = 0;
  let right = lines.length - 1;
  let answer = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (lines[mid].timeMs <= currentMs) {
      answer = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return answer;
}
