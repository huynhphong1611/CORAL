/** `Button` matches `android.widget.Button`; a full name must match exactly (D14). */
export function classMatches(actual: string, wanted: string): boolean {
  if (actual === wanted) return true
  if (wanted.includes('.')) return false
  return actual.slice(actual.lastIndexOf('.') + 1) === wanted
}
