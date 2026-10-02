import { Canvas, ColorMatrix, LinearGradient, Rect, useCanvasSize, vec } from '@shopify/react-native-skia';
import { StyleSheet, View, ViewStyle } from 'react-native';

import type { CameraFilter } from '@/lib/filters';

interface FilterSwatchProps {
  filter: CameraFilter;
  style: ViewStyle;
}

/**
 * What a filter looks like, drawn through its own matrix.
 *
 * The picker used to fill the swatch with a flat colour and stack the viewfinder tints over it,
 * which is a picture of the approximation rather than of the filter: a sepia swatch came out a
 * uniform brown, and nothing about the swatch could ever show that B&W removes colour. This runs
 * the real 4x5 matrix over a small warm gradient instead, so the swatch is the same code path as
 * the photo and it cannot drift from it.
 *
 * The gradient carries warm highlights, skin, mid brown and a deep shadow. A flat fill would prove
 * nothing, because a matrix with an offset in it barely changes a single colour, whereas a gradient
 * shows the whole range: lifted blacks at the dark end, clipped highlights at the light one.
 */
export function FilterSwatch({ filter, style }: FilterSwatchProps) {
  // The canvas cannot report layout on the new architecture, and a Rect needs real numbers rather
  // than percentages, so the size comes from the hook that watches the canvas itself.
  const { ref, size } = useCanvasSize();

  return (
    <View style={[styles.clip, style]}>
      <Canvas ref={ref} style={StyleSheet.absoluteFill}>
        {size.width > 0 && size.height > 0 ? (
          <Rect height={size.height} width={size.width} x={0} y={0}>
            <LinearGradient
              colors={['#F6E3C0', filter.previewBase, '#6B4423', '#241C12']}
              end={vec(1, 1)}
              start={vec(0, 0)}
            />
            <ColorMatrix matrix={filter.matrix} />
          </Rect>
        ) : null}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  // The gradient and the matrix both need to stay inside the rounded swatch, which is what the
  // sheet's own overflow hidden used to do for the flat fill.
  clip: { overflow: 'hidden' },
});