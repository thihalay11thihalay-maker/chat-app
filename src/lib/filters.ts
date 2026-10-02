/**
 * The camera filters offered in the sheet on the capture screen.
 *
 * Every filter carries two descriptions of itself:
 *
 * - `matrix`, a 4x5 colour matrix, is the real filter. Skia applies it when the photo is written
 *   and when the captured photo is drawn, so the file that gets posted really is filtered.
 * - `layers` is a stack of tints drawn over the live viewfinder. Skia cannot wrap the native
 *   camera preview, and a plain view cannot desaturate one, so the live frame gets an
 *   approximation of the look and the accurate version appears the moment the photo is captured.
 *
 * The matrix is row major, four rows of five: three colour rows with a bias column, then the
 * alpha row. The numbers are per channel weight plus a constant, so
 * [0.2126, 0.7152, 0.0722] is luminance: it replaces each channel with a weighted mix of all
 * three, which is what turns the frame grey.
 */
export interface FilterLayer {
  color: string;
  /** 0 to 1. Kept low per layer so a two layer filter still shows the scene underneath. */
  opacity: number;
}

export interface CameraFilter {
  id: string;
  label: string;
  /** The real filter, applied to the saved file. Empty means the frame is untouched. */
  matrix: number[];
  /** Layers drawn over the live viewfinder to preview this filter. */
  layers: FilterLayer[];
  /** The colour of the swatch in the sheet, so the row reads as a set of different looks. */
  previewBase: string;
}

export const DEFAULT_FILTER_ID = 'original';

const IDENTITY_MATRIX = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

// Luminance weights, the standard coefficients for sRGB.
const LUMA = [0.2126, 0.7152, 0.0722, 0, 0];

export const CAMERA_FILTERS: CameraFilter[] = [
  {
    id: 'original',
    label: 'Original',
    matrix: IDENTITY_MATRIX,
    layers: [],
    previewBase: '#4B5563',
  },
  {
    // Every output channel becomes luminance, so no hue survives anywhere in the frame.
    id: 'bw',
    label: 'B&W',
    matrix: [...LUMA, ...LUMA, ...LUMA, 0, 0, 0, 1, 0],
    // Grey over the frame plus a touch of black. It cannot desaturate, so it reads as a contrast
    // push here and only becomes the real conversion once the photo has been processed.
    layers: [
      { color: '#9CA3AF', opacity: 0.55 },
      { color: '#000000', opacity: 0.14 },
    ],
    previewBase: '#9CA3AF',
  },
  {
    // The classic sepia matrix: warm reds and greens, with blue contributing least. The rows sum
    // to more than one, which is why a near white frame clips to (255, 255, 239). That is the
    // textbook matrix behaving as it always has, and it is left alone rather than rescaled: a
    // sepia that has been dialled back stops reading as sepia.
    id: 'sepia',
    label: 'Sepia',
    matrix: [
      0.393, 0.769, 0.189, 0, 0,
      0.349, 0.686, 0.168, 0, 0,
      0.272, 0.534, 0.131, 0, 0,
      0, 0, 0, 1, 0,
    ],
    layers: [
      { color: '#8B5A2B', opacity: 0.3 },
      { color: '#F2D9A0', opacity: 0.16 },
    ],
    previewBase: '#B07C4A',
  },
  {
    // Warm and faded, the way an old print looks: less contrast than the camera took, a warm
    // bias, and blacks lifted off zero so the shadows go milky rather than staying hard.
    //
    // Three things are deliberate, and each is a row sum plus an offset:
    //
    // - Every row sums to less than one (0.92, 0.85, 0.70). A row sum above one is a gain, and a
    //   gain in red is what made this filter read as a white wash: anything reasonably bright had
    //   its red channel clipped to 255, so skies and faces came out flat cream.
    // - The offsets in the last column lift black to a warm dark (18, 14, 6) instead of leaving it
    //   at zero. That, not the gain, is what makes it faded.
    // - The blue row is pulled furthest down, so the colour lands on warm cream and brown rather
    //   than on grey. White ends up at (253, 231, 185): warm, and short of clipping.
    id: 'vintage',
    label: 'Vintage',
    matrix: [
      0.42, 0.38, 0.12, 0, 18,
      0.36, 0.36, 0.13, 0, 14,
      0.28, 0.28, 0.14, 0, 6,
      0, 0, 0, 1, 0,
    ],
    // Kept faint on purpose. The matrix is already a strong warm shift, so a heavy tint on the
    // live viewfinder would promise a much browner photo than the file ends up being.
    layers: [
      { color: '#C89B63', opacity: 0.16 },
      { color: '#2A241C', opacity: 0.16 },
    ],
    previewBase: '#9A7A52',
  },
];

// An unrecognised id falls back to the untouched frame rather than throwing: the value can arrive
// from a route param or a stale render, and neither is a reason to break the screen.
export function toCameraFilter(id: string): CameraFilter {
  return CAMERA_FILTERS.find((filter) => filter.id === id) ?? CAMERA_FILTERS[0];
}