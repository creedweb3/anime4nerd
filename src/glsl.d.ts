/** Set by build.mjs: true in the Firefox build (npm run build:firefox). */
declare const __FIREFOX__: boolean;

declare module '*.glsl' {
  const shader: string;
  export default shader;
}
