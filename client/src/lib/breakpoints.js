// Mirrors the --bp-* custom properties in styles/tokens.css. Kept in sync
// manually — CSS custom properties can't be read into a @media condition,
// so any component that needs breakpoint logic in JS (rather than pure
// CSS) reads these instead of hardcoding pixel values.
export const BREAKPOINTS = {
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
};
