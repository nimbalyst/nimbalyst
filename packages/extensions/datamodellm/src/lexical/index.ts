/**
 * DataModelLM Lexical Integration
 *
 * Provides Lexical node, transformer, and picker for embedding
 * data models in markdown documents.
 */

// Node
export {
  DataModelNode,
  $createDataModelNode,
  $isDataModelNode,
  type DataModelPayload,
  type SerializedDataModelNode,
} from './DataModelNode';

// Transformer
export { DATAMODEL_TRANSFORMER } from './DataModelTransformer';

// Platform Service
export {
  setDataModelPlatformService,
  getDataModelPlatformService,
  hasDataModelPlatformService,
  type DataModelPlatformService,
  type DataModelFileInfo,
} from './DataModelPlatformService';

// Picker Menu
export {
  INSERT_DATAMODEL_COMMAND,
  showDataModelPickerMenu,
  DataModelPickerMenuHost,
} from './DataModelPickerMenu';
