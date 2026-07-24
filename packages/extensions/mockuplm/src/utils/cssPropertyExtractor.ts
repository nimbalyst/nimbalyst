/**
 * CSS Property Extractor
 *
 * Reads computed styles from a selected element in the mockup iframe,
 * extracting the key visual properties that are useful for editing.
 */

export interface ExtractedProperties {
  // Text
  textContent: string;
  tagName: string;

  // Dimensions
  width: string;
  height: string;
  padding: string;
  margin: string;

  // Typography
  fontSize: string;
  fontWeight: string;
  color: string;
  textAlign: string;

  // Background & Border
  background: string;
  borderRadius: string;
  border: string;

  // Layout
  display: string;
  flexDirection: string;
  gap: string;
  alignItems: string;
  justifyContent: string;

  // Component attributes (for nim-* elements)
  componentAttrs: Record<string, string>;
}

/**
 * Extract editable properties from a DOM element in the iframe.
 */
export function extractProperties(element: Element): ExtractedProperties {
  const computed = window.getComputedStyle(element);
  const htmlEl = element as HTMLElement;

  // Collect component attributes for nim-* elements
  const componentAttrs: Record<string, string> = {};
  const tagLower = element.tagName.toLowerCase();
  if (tagLower.startsWith('nim-')) {
    for (const attr of Array.from(element.attributes)) {
      if (!attr.name.startsWith(':') && !attr.name.startsWith('@') && attr.name !== 'class' && attr.name !== 'style') {
        componentAttrs[attr.name] = attr.value;
      }
    }
  }

  return {
    textContent: htmlEl.textContent?.trim().slice(0, 200) || '',
    tagName: tagLower,
    width: computed.width,
    height: computed.height,
    padding: computed.padding,
    margin: computed.margin,
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    color: computed.color,
    textAlign: computed.textAlign,
    background: computed.backgroundColor,
    borderRadius: computed.borderRadius,
    border: computed.border,
    display: computed.display,
    flexDirection: computed.flexDirection,
    gap: computed.gap,
    alignItems: computed.alignItems,
    justifyContent: computed.justifyContent,
    componentAttrs,
  };
}

/**
 * Key CSS properties that are commonly edited in mockups.
 */
export const EDITABLE_CSS_PROPERTIES = [
  { key: 'color', label: 'Text Color', type: 'color' as const },
  { key: 'background', label: 'Background', type: 'color' as const },
  { key: 'fontSize', label: 'Font Size', type: 'text' as const },
  { key: 'fontWeight', label: 'Font Weight', type: 'select' as const, options: ['400', '500', '600', '700'] },
  { key: 'padding', label: 'Padding', type: 'text' as const },
  { key: 'margin', label: 'Margin', type: 'text' as const },
  { key: 'borderRadius', label: 'Border Radius', type: 'text' as const },
  { key: 'gap', label: 'Gap', type: 'text' as const },
  { key: 'textAlign', label: 'Text Align', type: 'select' as const, options: ['left', 'center', 'right'] },
] as const;
