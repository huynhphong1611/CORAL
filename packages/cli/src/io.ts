/** Where commands write and how they report their exit code; swapped out in tests. */
export interface CliIo {
  out(text: string): void
  err(text: string): void
  setExitCode(code: number): void
}

export const processIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code
  },
}
