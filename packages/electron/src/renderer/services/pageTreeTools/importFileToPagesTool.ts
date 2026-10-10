/**
 * importFileToPages: an agent copies a file from disk into Pages, the way a
 * person does with Copy to Pages... An agent asked to put a diagram in the
 * wiki wrote it to the repository and linked the path from a Team page
 * (NIM-7397); with this it imports the file as a page instead.
 *
 * It is `createSharedDoc` with the creation swapped for the share flow, so the
 * parent, ordering and returned link work the same, and the copy gets what a
 * person's copy gets: the type from the file name, its content in that type's
 * format, uploaded images, and on Team the link back to the local file.
 */
import { createPageTool, type PageTreeToolEnv, type PageTreeToolResult } from '@nimbalyst/collab-client/docs/pageTreeToolCore';
import { getFileName } from '../../utils/pathUtils';
import { splitShareFileName } from '../../components/ShareToTeamDialog/ShareToTeamDialog';
import { resolveShareDescriptor, shareFileToTeam } from '../shareToTeamFlow';
import { personalPageSupportsType } from '../personalPageTypes';

export async function importFileToPagesTool(
  env: PageTreeToolEnv,
  args: Record<string, unknown>,
  share: typeof shareFileToTeam = shareFileToTeam,
): Promise<PageTreeToolResult> {
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  if (!filePath.startsWith('/') && !/^[a-z]:[\\/]/i.test(filePath)) {
    return { success: false, error: 'importFileToPages needs the absolute path of a file on this computer.' };
  }
  const fileName = getFileName(filePath);
  const resolved = resolveShareDescriptor(fileName);
  if (!resolved.ok) return { success: false, error: resolved.reason };
  const { descriptor } = resolved;
  const section = args.section === 'personal' ? 'personal' : 'team';
  if (section === 'personal' && !personalPageSupportsType(descriptor.documentType)) {
    return { success: false, error: `A Personal page cannot hold ${fileName}; import it into the team section.` };
  }
  const { baseName, suffix } = splitShareFileName(fileName, descriptor);
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : baseName;

  let warnings: string[] = [];
  const importing: PageTreeToolEnv = {
    ...env,
    createPage: async (_section, _session, input) => {
      if (input.parentKind === 'item') throw new Error('Import under a plain page or at the top of the section, not under a typed page.');
      const result = await share({
        filePath,
        fileName,
        answers: {
          descriptor,
          section,
          folderId: input.parentId,
          folderPath: '',
          sharedName: `${input.title}${suffix}`,
          embeddedDocuments: [],
          selectedEmbeddedDocumentPaths: [],
        },
        openAfterCreate: false,
        persistLastSharedFolder: false,
        showNotifications: false,
      });
      if (result.status !== 'shared') throw new Error(result.error);
      warnings = result.warnings ?? [];
      return result.documentId;
    },
  };
  const created = await createPageTool(importing, { ...args, section, title, documentType: descriptor.documentType });
  if (!created.success || warnings.length === 0) return created;
  const earlier = typeof created.warning === 'string' ? `${created.warning} ` : '';
  return { ...created, warning: `${earlier}Imported, but ${warnings.join('; ')}.` };
}
