export const KATEX_SAFE_OPTIONS = {
  trust: false,
  strict: 'ignore' as const,
  throwOnError: false,
  output: 'html' as const,
  maxSize: 25,
  maxExpand: 100,
  macros: {},
};

export function buildKatexOptions(displayMode: boolean) {
  return {
    ...KATEX_SAFE_OPTIONS,
    displayMode,
  };
}
