import { File, Paths } from 'expo-file-system';
import { ImageFormat, Skia } from '@shopify/react-native-skia';

// The processed photo is re-encoded rather than written back over the camera's own file: the
// camera writes into the cache and nothing else reads that path afterwards, but overwriting a
// file the camera owns is the kind of thing that breaks again after an SDK bump.
const OUTPUT_NAME_PREFIX = 'filter_';

// JPEG rather than PNG: a filtered full size photo is several megabytes as a lossless PNG, and
// 95 is below the point where the re-encode is visible while keeping the file small enough to
// upload over mobile data.
const OUTPUT_FORMAT = ImageFormat.JPEG;
const OUTPUT_QUALITY = 95;

/**
 * Applies a 4x5 colour matrix to a photo and writes the result to a new file.
 *
 * The work happens on an offscreen Skia surface: the file is decoded, drawn once with a paint
 * carrying the colour filter, and the surface is snapshotted and encoded. Nothing is done per
 * pixel in JavaScript, which is why a full size photo is quick enough to run between the shutter
 * and the preview.
 *
 * Returns the uri of the filtered file, or null when the photo could not be processed. Null is a
 * normal outcome rather than a failure to shout about: the caller falls back to the original file
 * and the user gets an unfiltered post instead of an error.
 */
export async function applyFilterToImageFile(uri: string, matrix: number[]): Promise<string | null> {
  try {
    const data = await Skia.Data.fromURI(uri);

    if (!data) {
      return null;
    }

    const image = Skia.Image.MakeImageFromEncoded(data);

    if (!image) {
      return null;
    }

    const width = image.width();
    const height = image.height();

    if (width <= 0 || height <= 0) {
      return null;
    }

    const surface = Skia.Surface.MakeOffscreen(width, height);

    if (!surface) {
      return null;
    }

    const paint = Skia.Paint();
    paint.setColorFilter(Skia.ColorFilter.MakeMatrix(matrix));

    const canvas = surface.getCanvas();
    // The photo is drawn edge to edge at its own size, so the surface needs no scaling and the
    // result is pixel for pixel the photo the camera took. Clearing to transparent matters
    // because a surface starts out undefined rather than empty.
    canvas.clear(Skia.Color('transparent'));
    canvas.drawImage(image, 0, 0, paint);

    const filtered = surface.makeImageSnapshot();
    const bytes = filtered.encodeToBytes(OUTPUT_FORMAT, OUTPUT_QUALITY);

    if (!bytes || bytes.length === 0) {
      return null;
    }

    // Unique per photo rather than per millisecond: two shots filtered inside the same tick would
    // otherwise land on one name, and `overwrite` would hand the second the first's pixels.
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const file = new File(Paths.cache, `${OUTPUT_NAME_PREFIX}${unique}.jpg`);
    file.create({ overwrite: true });
    file.write(bytes);

    return file.uri;
  } catch (error) {
    console.warn('Could not apply the filter to the photo:', error);
    return null;
  }
}