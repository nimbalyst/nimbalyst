// Vite-specific module declarations

declare module '*.css?inline' {
  const content: string;
  export default content;
}
