export { mountCollabEditor } from './mount';
export { resolveCollabEditorUser } from './presence';
export { installCollabEditorBridge } from './bridge';
export type {
  BridgeAuthResponse,
  BridgeFlushRequest,
  BridgeMountRequest,
  EditorBridgeMessage,
  InstallEditorBridgeOptions,
  NimbalystEditorBridgeApi,
} from './bridge';
export type {
  CollabEditorConnectionState,
  CollabEditorFlushResult,
  CollabEditorHandle,
  CollabEditorMountOptions,
  CollabEditorParticipant,
  CollabEditorPresence,
  CollabEditorSource,
  CollabEditorState,
  CollabEditorServerAccess,
  CollabEditorTermination,
  CollabEditorUser,
  CollabEditorWriteRejection,
  InMemorySource,
  ResolvedCollabEditorUser,
  TeamDocumentId,
  TeamJwt,
  TeamMemberId,
  TeamOrgId,
  TeamProjectId,
  TeamRoomAuth,
  TeamRoomIdentity,
  TeamRoomSource,
  TextFormatType,
} from './types';
export {
  asTeamDocumentId,
  asTeamOrgId,
  asTeamProjectId,
} from './types';

// Advanced codec-host exports remain behind the editor entry. The docs-ui
// entry does not pull them, and mobile hosts never need to import the shell.
export {
  CollabLexicalProvider,
  HeadlessLexicalYDoc,
  MarkdownCollabContentAdapter,
} from '@nimbalyst/runtime/collab-lexical';
export type { HeadlessLexicalYDocOptions } from '@nimbalyst/runtime/collab-lexical';
