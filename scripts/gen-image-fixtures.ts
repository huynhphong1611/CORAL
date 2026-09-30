// Regenerates fixtures/images/ (Phase 2 T012) from fixtures/android/login.xml with renderTree:
//   node --import tsx scripts/gen-image-fixtures.ts
// The PNGs are committed; this script documents how they were made (fixtures/images/README.md).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { walkTree, type ElementNode } from '@coral/shared'
import { android } from '@coral/runner'
import { renderTree } from '@coral/runner/testing'
import { cropPng } from '../packages/runner/src/core/image/png.ts'

const root = new URL('../', import.meta.url)
const out = new URL('fixtures/images/', root)
const SIZE = { width: 1080, height: 2400 }
const BUTTON = 'com.saucelabs.mydemoapp.android:id/loginBtn'

const login = () =>
  android.parseHierarchy(readFileSync(new URL('fixtures/android/login.xml', root), 'utf8'))

function edit(
  tree: ElementNode[],
  change: (node: ElementNode, parent: ElementNode) => void,
): ElementNode[] {
  const copy = structuredClone(tree)
  for (const parent of walkTree(copy)) for (const node of [...parent.children]) change(node, parent)
  return copy
}

const button = [...walkTree(login())].find((n) => n.platform_id === BUTTON)
if (!button) throw new Error('loginBtn not in login.xml')

const files: Record<string, Uint8Array> = {
  'login-screen.png': renderTree(login(), SIZE),
  'login-button.png': cropPng(renderTree(login(), SIZE), button.bounds),
  // New id, button 240 px lower: structured locators miss, the image still matches.
  'login-moved.png': renderTree(
    edit(login(), (node) => {
      if (node.platform_id !== BUTTON) return
      node.platform_id = 'com.saucelabs.mydemoapp.android:id/signInButton'
      node.bounds = { ...node.bounds, y: node.bounds.y + 240 }
    }),
    SIZE,
  ),
  // The same screen drawn 720 px wide: matching scales the template by screen_width.
  'login-720.png': renderTree(login(), SIZE, { scale: 720 / 1080 }),
  // No login button: nothing may match.
  'login-no-button.png': renderTree(
    edit(login(), (node, parent) => {
      if (node.platform_id === BUTTON) parent.children.splice(parent.children.indexOf(node), 1)
    }),
    SIZE,
  ),
}

mkdirSync(out, { recursive: true })
for (const [name, png] of Object.entries(files)) {
  writeFileSync(new URL(name, out), png)
  console.log(`${name} ${png.length} bytes`)
}
console.log(`button bounds ${JSON.stringify(button.bounds)}`)
