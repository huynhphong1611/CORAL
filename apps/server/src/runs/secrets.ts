/**
 * Where secret values come from. Phase 1 (dev only, D19): server environment variables
 * `CORAL_SECRET_<NAME>`; the encrypted `secrets` table replaces this in Phase 5.
 */
export interface SecretSource {
  /** Values of the names that exist; missing names are absent. */
  get(names: readonly string[]): Record<string, string>
  /** Every secret name (the Recorder spots text typed that equals a secret, FR-014). */
  names(): string[]
}

export function envSecrets(env: Record<string, string | undefined>): SecretSource {
  return {
    get(names) {
      const values: Record<string, string> = {}
      for (const name of names) {
        const value = env[`CORAL_SECRET_${name}`]
        if (value !== undefined) values[name] = value
      }
      return values
    },
    names() {
      return Object.keys(env)
        .filter((key) => key.startsWith('CORAL_SECRET_') && env[key] !== undefined)
        .map((key) => key.slice('CORAL_SECRET_'.length))
    },
  }
}
