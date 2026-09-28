// Vite's import.meta.glob, used by tests to load fixture files without Node APIs.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options: { eager: true; query?: string; import?: string },
  ): Record<string, T>
}
