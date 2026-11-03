// The braille spinner's frames, as dots on a 2×3 cell: bit n of a glyph's code is braille dot n+1. Drawn rather than
// typed, as Geist Mono has no braille and the fallback font changes by machine, in shape and in width. `ui/Spinner` draws
// them in the app, and `scripts/spa-loading.ts` in the start-up screen, before Vue exists (ORR-815).
export const SPINNER_FRAMES = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
const CELL = [[3, 3], [3, 7], [3, 11], [7, 3], [7, 7], [7, 11]] as const

/** Every frame's dots in one tall picture, 10 wide and 14 a frame, which CSS moves up a frame at a time. */
export const SPINNER_DOTS = SPINNER_FRAMES.flatMap((glyph, frame) => CELL.flatMap(([x, y], dot) =>
    ((glyph.codePointAt(0) ?? 0) - 0x2800) >> dot & 1 ? [{x, y: y + frame * 14}] : []))

/** The picture's viewBox, and each dot's radius. */
export const SPINNER_VIEWBOX = `0 0 10 ${SPINNER_FRAMES.length * 14}`
export const SPINNER_DOT_RADIUS = 1.4
