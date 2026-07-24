/**
 * Image transformer for markdown import/export
 */

import { TextMatchTransformer } from '@lexical/markdown';
import { $createImageNode, $isImageNode, ImageNode } from './ImageNode';

export const IMAGE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => {
    if (!$isImageNode(node)) {
      return null;
    }

    const altText = node.getAltText();
    const src = node.getSrc();
    const width = node.__width;
    const height = node.__height;

    // Only add size if both width and height are set and not 'inherit'
    if (width !== 'inherit' && height !== 'inherit') {
      return `![${altText}](${src}){${Math.round(width)}x${Math.round(height)}}`;
    }

    return `![${altText}](${src})`;
  },
  // Note: This regex must NOT match:
  // 1. Mockup syntax which has {mockup:...} after the image (old format)
  // 2. Linked images like [![alt](src)](link) used for mockups
  // The negative lookbehind (?<!\[) ensures we don't match images inside linked images
  // (linked image format is [![...](...)], so the ! is preceded by [)
  // The negative lookahead (?!\{mockup:) ensures we don't capture old mockup syntax
  importRegExp: /(?<!\[)!(?:\[([^[]*)\])(?:\(([^(]+)\))(?!\{mockup:)(?:\{(\d+)x(\d+)\})?/,
  regExp: /(?<!\[)!(?:\[([^[]*)\])(?:\(([^(]+)\))(?!\{mockup:)(?:\{(\d+)x(\d+)\})?$/,
  replace: (textNode, match) => {
    const [, altText, src, width, height] = match;
    const imageNode = $createImageNode({
      altText,
      maxWidth: 10000,
      src,
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
    });
    textNode.replace(imageNode);
  },
  trigger: ')',
  type: 'text-match',
};