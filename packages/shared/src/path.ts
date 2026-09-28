/** `["steps", 3, "target"]` → `steps[3].target` (the path format of every coral error). */
export function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`,
    )
    .join('')
}
