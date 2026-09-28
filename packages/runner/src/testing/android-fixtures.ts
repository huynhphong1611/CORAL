import { readdirSync, readFileSync } from 'node:fs'
import type { ElementNode } from '@coral/shared'
import { parseHierarchy } from '../drivers/android/hierarchy'

const dir = new URL('../../../../fixtures/android/', import.meta.url)

export const ANDROID_FIXTURES = readdirSync(dir).filter((f) => f.endsWith('.xml'))

/** Loads `fixtures/android/<name>.xml` as parsed windows (test helper). */
export function androidTree(name: string): ElementNode[] {
  return parseHierarchy(readFileSync(new URL(`${name}.xml`, dir), 'utf8'))
}

export const APP = 'com.saucelabs.mydemoapp.android'
