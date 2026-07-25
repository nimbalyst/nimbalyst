/**
 * Narrow Extension SDK entry used by the Electron main-process bundle.
 *
 * The public SDK barrel includes renderer hooks and components. Main-process
 * code only needs manifest validation, tracker-importer constants, and the
 * serializable collaboration adapter factory.
 */

export {
  effectiveModulePermissions,
  validateBackendModules,
} from './manifestValidation';
export { TRACKER_IMPORTER_RPC_METHODS } from './types/trackerImporter';
export {
  createTextCollabContentAdapter,
  reconstructCollabContentAdapterFromDescriptor,
} from './collab/createTextCollabContentAdapter';
export { COLLAB_INIT_ORIGIN } from './collab/origins';
