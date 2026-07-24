import * as fs from 'fs/promises';
import * as path from 'path';

export class TrackerLoaderService {
  /**
   * Ensure the trackers directory exists, create if needed
   */
  async ensureTrackersDirectory(workspacePath: string): Promise<void> {
    const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');

    try {
      // List files BEFORE mkdir to see what's there
      try {
        const filesBefore = await fs.readdir(trackersDir);
        console.log(`[TrackerLoader] Files BEFORE mkdir:`, filesBefore);
      } catch (e) {
        console.log(`[TrackerLoader] Directory doesn't exist yet`);
      }

      await fs.mkdir(trackersDir, { recursive: true });
      console.log(`[TrackerLoader] Ensured trackers directory exists: ${trackersDir}`);

      // List files AFTER mkdir
      const filesAfter = await fs.readdir(trackersDir);
      console.log(`[TrackerLoader] Files AFTER mkdir:`, filesAfter);

      // Create a README file if it doesn't exist
      const readmePath = path.join(trackersDir, 'README.md');
      const readmeExists = await fs
        .access(readmePath)
        .then(() => true)
        .catch(() => false);

      if (!readmeExists) {
        const readmeContent = `# Custom Trackers

Place your custom tracker YAML files in this directory.

See the documentation for creating custom trackers:
- UserDocs/creating-custom-trackers.md

Example trackers:
- UserDocs/examples/character.yaml
- UserDocs/examples/recipe.yaml
- UserDocs/examples/research-paper.yaml

Copy an example file here and restart Nimbalyst to use it.
`;

        await fs.writeFile(readmePath, readmeContent, 'utf8');
        console.log(`[TrackerLoader] Created README in trackers directory`);
      }
    } catch (error) {
      console.error(`[TrackerLoader] Failed to create trackers directory:`, error);
    }
  }
}

// Singleton instance
let trackerLoaderService: TrackerLoaderService | null = null;

export function getTrackerLoaderService(): TrackerLoaderService {
  if (!trackerLoaderService) {
    trackerLoaderService = new TrackerLoaderService();
  }
  return trackerLoaderService;
}
