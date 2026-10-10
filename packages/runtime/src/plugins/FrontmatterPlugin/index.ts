/**
 * FrontmatterPlugin - generic YAML frontmatter as editable properties
 *
 * A host shows `FrontmatterProperties` in a side panel (desktop: Page info)
 * for documents `shouldRenderGenericFrontmatter` claims; tracker documents get
 * the tracker header instead.
 */

export { FrontmatterProperties, type FrontmatterPropertiesProps } from './FrontmatterProperties';
export {
  shouldRenderGenericFrontmatter,
  frontmatterStatusBadge,
  type FrontmatterStatusBadge,
} from './frontmatterPresence';
export {
  extractFrontmatter,
  extractFrontmatterWithError,
  parseFields,
  inferFieldType,
  updateFieldInFrontmatter,
  hasGenericFrontmatter,
  type InferredField,
  type InferredFieldType,
  type FrontmatterParseResult,
} from './fieldUtils';
