import { Canvas, ColorMatrix, Image as SkiaImage, useCanvasSize, useImage } from '@shopify/react-native-skia';
import { Image, StyleProp, StyleSheet, ViewStyle } from 'react-native';

interface FilteredImageProps {
  /** The 4x5 colour matrix from the chosen filter. */
  matrix: number[];
  style?: StyleProp<ViewStyle>;
  uri: string;
}

/**
 * A photo drawn through a colour matrix.
 *
 * The matrix runs on the GPU over the real image, so the B&W row actually removes colour instead of
 * washing over it. Only use this for a photo whose file does not already carry the filter: the
 * matrix here is applied on top of whatever the file holds, so pointing it at an already filtered
 * photo filters it twice.
 *
 * React Native's Image sits underneath as the floor. The photo decodes asynchronously on both
 * sides, and a Canvas with nothing in it is a blank panel over the frame, which reads as a grey
 * card rather than as a photo that is still loading. If the decode fails the unfiltered photo is
 * what remains, which is honest: it is exactly what this component was handed.
 *
 * The size comes from useCanvasSize rather than from onLayout, because a Canvas does not report
 * layout on the new architecture, and Skia's Image node needs explicit numbers rather than
 * percentages. Measuring through the canvas also means the drawing survives a rotation or a split
 * screen, which a size read off the decoded image would not.
 */
export function FilteredImage({ matrix, style, uri }: FilteredImageProps) {
  const image = useImage(uri);
  const { ref, size } = useCanvasSize();

  // Nothing is drawn until both are known: the node is given a size, and a zero sized node would
  // quietly render nothing at all rather than fail.
  const isReady = Boolean(image) && size.width > 0 && size.height > 0;

  return (
    <>
      <Image resizeMode="cover" source={{ uri }} style={StyleSheet.absoluteFill} />

      <Canvas ref={ref} style={style ?? StyleSheet.absoluteFill}>
        {image && isReady ? (
          <SkiaImage fit="cover" height={size.height} image={image} width={size.width}>
            <ColorMatrix matrix={matrix} />
          </SkiaImage>
        ) : null}
      </Canvas>
    </>
  );
}