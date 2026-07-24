// Minimal ambient types for picomatch (no @types/picomatch installed). Only the
// surface the engine uses: build a matcher from one or more glob patterns.
declare module 'picomatch' {
  type Matcher = (str: string) => boolean;
  interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
    contains?: boolean;
  }
  function picomatch(glob: string | string[], options?: PicomatchOptions): Matcher;
  export = picomatch;
}
