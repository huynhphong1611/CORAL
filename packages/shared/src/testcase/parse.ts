import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml'

export interface SourcePosition {
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
}

export interface YamlProblem extends SourcePosition {
  message: string
}

export interface ParsedYaml {
  /** Plain JS value; undefined when the YAML has syntax errors. */
  value: unknown
  errors: YamlProblem[]
  /**
   * Where `path` (e.g. `['steps', 3, 'target', 1]`) sits in the source. When the path does not
   * exist (a missing key), returns the deepest existing ancestor so the editor still points close.
   */
  positionOf: (path: readonly PropertyKey[]) => SourcePosition | undefined
}

/** Parses YAML while keeping node positions for error reporting (T021). */
export function parseYaml(source: string): ParsedYaml {
  const lineCounter = new LineCounter()
  const doc = parseDocument(source, { lineCounter, prettyErrors: false, uniqueKeys: true })
  const toPosition = (offset: number): SourcePosition => {
    const { line, col } = lineCounter.linePos(offset)
    return { line, column: col }
  }

  const errors = doc.errors.map((error) => ({
    message: error.message.split('\n')[0] ?? error.message,
    ...toPosition(error.pos[0]),
  }))

  function positionOf(path: readonly PropertyKey[]): SourcePosition | undefined {
    let node: unknown = doc.contents
    let best: number | undefined = (node as Node | null)?.range?.[0]
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && item.key.value === segment)
        if (!pair) break
        best = (pair.key as Node).range?.[0] ?? best
        node = pair.value
      } else if (isSeq(node) && typeof segment === 'number') {
        const item: unknown = node.items[segment]
        if (!item) break
        node = item
        best = (item as Node).range?.[0] ?? best
      } else {
        break
      }
    }
    return best === undefined ? undefined : toPosition(best)
  }

  return {
    value: errors.length > 0 ? undefined : (doc.toJS() as unknown),
    errors,
    positionOf,
  }
}
