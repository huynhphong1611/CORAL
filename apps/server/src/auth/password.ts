import { hash, verify } from '@node-rs/argon2'

/** `Algorithm.Argon2id`; the const enum cannot be imported under verbatimModuleSyntax. */
const ARGON2ID = 2

/** argon2id with library defaults (SPEC §5.2, research R12). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID })
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}
