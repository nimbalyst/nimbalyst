export const MATERIAL_SYMBOLS_FONT =
  'normal 400 24px "Material Symbols Outlined"';
export const MATERIAL_SYMBOLS_SAMPLE = 'progress_activity';

type FontLoader = Pick<FontFaceSet, 'load'>;

/**
 * Ensure Material Symbols ligatures resolve as icons before the app paints its
 * real UI. The font is bundled with the renderer, so a failure means the build
 * is incomplete and startup should fail rather than expose raw ligature text.
 */
export async function waitForMaterialSymbols(
  fonts: FontLoader = document.fonts,
): Promise<void> {
  const loadedFaces = await fonts.load(
    MATERIAL_SYMBOLS_FONT,
    MATERIAL_SYMBOLS_SAMPLE,
  );

  if (loadedFaces.length === 0) {
    throw new Error('Material Symbols font failed to load');
  }
}
