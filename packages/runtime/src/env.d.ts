/// <reference types="vite/client" />
/// <reference path="../../electron/src/renderer/electron.d.ts" />

declare module '*.css?inline' {
  const content: string;
  export default content;
}

declare module '*.yaml?raw' {
  const content: string;
  export default content;
}

declare module '*.yml?raw' {
  const content: string;
  export default content;
}
