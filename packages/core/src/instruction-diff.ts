const CONTEXT_LINES = 2;
/** Past this many table cells the middle is shown as fully replaced instead of matched line by line. */
const MAX_MATCH_CELLS = 4_000_000;

type DiffLine = { sign: " " | "-" | "+"; text: string };

/** The lines both sides share are kept; everything else is a removal then an addition. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const head = before.slice(0, start).map((text): DiffLine => ({ sign: " ", text }));
  const tail = before.slice(endBefore).map((text): DiffLine => ({ sign: " ", text }));
  const removed = before.slice(start, endBefore);
  const added = after.slice(start, endAfter);
  const replaced = (): DiffLine[] => [
    ...removed.map((text): DiffLine => ({ sign: "-", text })),
    ...added.map((text): DiffLine => ({ sign: "+", text })),
  ];
  if (
    !removed.length ||
    !added.length ||
    (removed.length + 1) * (added.length + 1) > MAX_MATCH_CELLS
  ) {
    return [...head, ...replaced(), ...tail];
  }

  // Longest common subsequence of the middle, filled from the end so the walk below runs forward.
  const width = added.length + 1;
  const common = new Uint32Array((removed.length + 1) * width);
  for (let i = removed.length - 1; i >= 0; i--) {
    for (let j = added.length - 1; j >= 0; j--) {
      common[i * width + j] =
        removed[i] === added[j]
          ? common[(i + 1) * width + j + 1]! + 1
          : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) {
      middle.push({ sign: " ", text: removed[i]! });
      i++;
      j++;
    } else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) {
      middle.push({ sign: "-", text: removed[i++]! });
    } else {
      middle.push({ sign: "+", text: added[j++]! });
    }
  }
  while (i < removed.length) middle.push({ sign: "-", text: removed[i++]! });
  while (j < added.length) middle.push({ sign: "+", text: added[j++]! });
  return [...head, ...middle, ...tail];
}

/**
 * Only the changed lines, each with a couple of unchanged lines around it, and a count where
 * unchanged lines are left out. Every removed line stays visible so approving never hides a
 * dropped constraint.
 */
export function instructionUpdateDiff(before: string, after: string): string {
  if (!before.trim()) return after;
  const lines = diffLines(before.split("\n"), after.split("\n"));
  const shown = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.sign === " ") return;
    for (
      let near = Math.max(0, index - CONTEXT_LINES);
      near <= Math.min(lines.length - 1, index + CONTEXT_LINES);
      near++
    ) {
      shown[near] = true;
    }
  });
  const out: string[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden) out.push(`… ${hidden} unchanged ${hidden === 1 ? "line" : "lines"}`);
    hidden = 0;
  };
  lines.forEach((line, index) => {
    if (shown[index] || !shown.includes(true)) {
      flush();
      out.push(`${line.sign} ${line.text}`);
    } else {
      hidden++;
    }
  });
  flush();
  return out.join("\n");
}
