import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { addNimAssetRoot, encodeNimAssetUrl } from '../protocols/nimAssetProtocol';
import { initialsLength, type ProjectAppearanceSnapshot, type ProjectAppearanceUpdate, type StoredProjectAppearance } from '../../shared/projectAppearance';

let revision = 0;
const IMAGE_ID = /^[a-f0-9-]{36}\.png$/;
function requireWorkspace(workspacePath: string): void {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath) || workspacePath.includes('\0')) {
    throw new Error('An absolute workspacePath is required.');
  }
}
function imageDirectory(): string {
  const directory = path.join(app.getPath('userData'), 'project-icons');
  addNimAssetRoot(directory);
  return directory;
}
function imagePath(id?: string): string | undefined {
  return id && IMAGE_ID.test(id) ? path.join(imageDirectory(), id) : undefined;
}
function decodeThumbnail(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 100_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  }
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  // Check the PNG header before the native decoder can allocate a large bitmap.
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 128
    || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 128) {
    throw new Error('Project icons must be thumbnails no larger than 128 × 128 pixels.');
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('This image could not be read. Choose another image.');
  const size = image.getSize();
  if (size.width > 128 || size.height > 128) throw new Error('Project icon is too large.');
  return image.toPNG();
}

export function getProjectAppearance(workspacePath: string): ProjectAppearanceSnapshot {
  requireWorkspace(workspacePath);
  const stored = getWorkspaceState(workspacePath).projectAppearance ?? {};
  const file = imagePath(stored.imageId);
  return {
    revision,
    appearance: {
      ...(typeof stored.initials === 'string' && stored.initials ? { initials: stored.initials } : {}),
      ...(typeof stored.color === 'string' && /^#[a-f0-9]{6}$/i.test(stored.color) ? { color: stored.color } : {}),
      ...(file ? { imageUrl: encodeNimAssetUrl(file) } : {}),
    },
  };
}

export function updateProjectAppearance(workspacePath: string, input: unknown): ProjectAppearanceSnapshot {
  requireWorkspace(workspacePath);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['initials', 'color', 'image'].includes(key))) {
    throw new Error('Invalid project appearance.');
  }
  const patch = input as ProjectAppearanceUpdate;
  if (patch.initials != null && (typeof patch.initials !== 'string' || patch.initials.length > 64
    || initialsLength(patch.initials.trim()) > 3 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(patch.initials))) {
    throw new Error('Use up to three characters for the initials.');
  }
  if (patch.color != null && (typeof patch.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(patch.color))) {
    throw new Error('Choose a valid color.');
  }
  const thumbnail = patch.image == null ? undefined : decodeThumbnail(patch.image);
  const previous = getWorkspaceState(workspacePath).projectAppearance ?? {};
  const next: StoredProjectAppearance = { ...previous };
  if (patch.initials !== undefined) {
    if (patch.initials?.trim()) next.initials = patch.initials.trim(); else delete next.initials;
  }
  if (patch.color !== undefined) {
    if (patch.color) next.color = patch.color.toLowerCase(); else delete next.color;
  }
  let newFile: string | undefined;
  if (patch.image !== undefined) {
    delete next.imageId;
    if (thumbnail) {
      next.imageId = `${randomUUID()}.png`;
      newFile = imagePath(next.imageId)!;
      fs.mkdirSync(imageDirectory(), { recursive: true });
      fs.writeFileSync(newFile, thumbnail, { flag: 'wx' });
    }
  }
  try {
    updateWorkspaceState(workspacePath, state => { state.projectAppearance = next; });
  } catch (error) {
    if (newFile) fs.rmSync(newFile, { force: true });
    throw error;
  }
  revision++;
  const oldFile = imagePath(previous.imageId);
  if (oldFile && previous.imageId !== next.imageId) {
    // Settings already committed: failure to remove an obsolete app-owned file
    // must not make the UI report that saving the new appearance failed.
    try { fs.rmSync(oldFile, { force: true }); }
    catch (error) { console.warn('[ProjectAppearance] Could not remove obsolete thumbnail:', error); }
  }
  return getProjectAppearance(workspacePath);
}
