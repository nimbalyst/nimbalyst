declare module 'prettier' {
  export interface Options {
    [key: string]: any;
  }
  export function format(source: string, options?: Options): string;
  export function formatWithCursor(source: string, options?: Options): any;
  export const version: string;
}

declare module 'prettier/standalone' {
  export * from 'prettier';
}

declare module 'prettier/parser-postcss' {
  const plugin: any;
  export default plugin;
}

declare module 'prettier/parser-html' {
  const plugin: any;
  export default plugin;
}

declare module 'prettier/parser-babel' {
  const plugin: any;
  export default plugin;
}

declare module 'prettier/parser-markdown' {
  const plugin: any;
  export default plugin;
}

declare module 'prettier/parser-typescript' {
  const plugin: any;
  export default plugin;
}
