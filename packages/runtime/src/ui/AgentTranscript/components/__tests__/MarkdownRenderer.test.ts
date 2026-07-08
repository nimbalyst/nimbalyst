import { describe, expect, it } from 'vitest';
import {
  resolveTranscriptFilePathFromHref,
  transcriptUrlTransform,
} from '../MarkdownRenderer';

describe('resolveTranscriptFilePathFromHref', () => {
  it('resolves unix absolute file paths', () => {
    expect(resolveTranscriptFilePathFromHref('/Users/test/project/src/file.ts')).toBe(
      '/Users/test/project/src/file.ts'
    );
  });

  it('strips line and column suffixes from file paths', () => {
    expect(resolveTranscriptFilePathFromHref('/Users/test/project/src/file.ts:42:7')).toBe(
      '/Users/test/project/src/file.ts'
    );
  });

  it('resolves file:// links and decodes path segments', () => {
    expect(resolveTranscriptFilePathFromHref('file:///Users/test/My%20Project/prompt.ts')).toBe(
      '/Users/test/My Project/prompt.ts'
    );
  });

  it('returns null for external web links', () => {
    expect(resolveTranscriptFilePathFromHref('https://nimbalyst.com/docs')).toBeNull();
  });

  it('returns null for non-absolute local paths', () => {
    expect(resolveTranscriptFilePathFromHref('src/ai/prompt.ts')).toBeNull();
  });

  // Claude Code emits markdown links with an `/abs/path/` prefix on
  // top of the real filesystem path. The reporter on #240 confirmed
  // these links failed to open on Windows because the literal path
  // does not exist. Strip the prefix before the absolute-path check
  // so the IPC handler receives the real on-disk path.
  it('strips /abs/path/ prefix on Windows-style paths', () => {
    expect(
      resolveTranscriptFilePathFromHref('/abs/path/C:/Users/test/project/src/file.ts')
    ).toBe('C:/Users/test/project/src/file.ts');
  });

  it('strips /abs/path/ prefix and line:column suffix on Windows-style paths', () => {
    expect(
      resolveTranscriptFilePathFromHref('/abs/path/C:/Users/test/project/src/file.ts:236')
    ).toBe('C:/Users/test/project/src/file.ts');
  });

  it('strips /abs/path/ prefix on macOS-style paths', () => {
    expect(
      resolveTranscriptFilePathFromHref('/abs/path//Users/test/project/src/file.ts')
    ).toBe('/Users/test/project/src/file.ts');
  });

  it('strips /abs/path/ prefix with line:column on macOS-style paths', () => {
    expect(
      resolveTranscriptFilePathFromHref('/abs/path//Users/test/project/src/file.ts:42:7')
    ).toBe('/Users/test/project/src/file.ts');
  });

  it('returns null when /abs/path/ wraps a non-absolute remainder', () => {
    // After stripping the prefix we have `relative/file.ts` which is not
    // an absolute filesystem path, so the renderer should leave it for
    // the default link handler rather than route it through workspace
    // file-open.
    expect(
      resolveTranscriptFilePathFromHref('/abs/path/relative/file.ts')
    ).toBeNull();
  });

  it('leaves non-/abs/path/ absolute paths untouched', () => {
    expect(
      resolveTranscriptFilePathFromHref('/Users/test/normal/file.ts')
    ).toBe('/Users/test/normal/file.ts');
  });

  // Windows bug (GitHub #744): drive-letter absolute paths were mishandled.
  // `D:\...` / `D:/...` look like a `d:` URI scheme and were rejected as
  // external links (opening a blank window); `/D:/...` passed through with a
  // spurious leading slash and failed with "File does not exist".
  it('resolves Windows drive-letter paths with backslashes', () => {
    expect(
      resolveTranscriptFilePathFromHref('D:\\work\\INCOMLibrary\\Source\\icThemes.pas')
    ).toBe('D:\\work\\INCOMLibrary\\Source\\icThemes.pas');
  });

  it('resolves Windows drive-letter paths with forward slashes', () => {
    expect(
      resolveTranscriptFilePathFromHref('D:/work/INCOMLibrary/Source/icThemes.pas')
    ).toBe('D:/work/INCOMLibrary/Source/icThemes.pas');
  });

  it('strips a spurious leading slash before a Windows drive letter', () => {
    expect(
      resolveTranscriptFilePathFromHref('/D:/work/INCOMLibrary/Source/icThemes.pas')
    ).toBe('D:/work/INCOMLibrary/Source/icThemes.pas');
  });

  it('strips line:column suffixes from Windows drive-letter paths', () => {
    expect(
      resolveTranscriptFilePathFromHref('D:/work/Source/icThemes.pas:42:7')
    ).toBe('D:/work/Source/icThemes.pas');
  });
});

describe('transcriptUrlTransform', () => {
  it('preserves Windows drive-letter paths that the default transform would blank', () => {
    expect(transcriptUrlTransform('D:\\work\\Source\\icThemes.pas')).toBe(
      'D:\\work\\Source\\icThemes.pas'
    );
    expect(transcriptUrlTransform('D:/work/Source/icThemes.pas')).toBe(
      'D:/work/Source/icThemes.pas'
    );
  });

  it('preserves leading-slash drive-letter and UNC paths', () => {
    expect(transcriptUrlTransform('/D:/work/Source/icThemes.pas')).toBe(
      '/D:/work/Source/icThemes.pas'
    );
    expect(transcriptUrlTransform('\\\\server\\share\\file.pas')).toBe(
      '\\\\server\\share\\file.pas'
    );
  });

  it('preserves POSIX absolute and relative paths', () => {
    expect(transcriptUrlTransform('/Users/test/file.ts')).toBe('/Users/test/file.ts');
    expect(transcriptUrlTransform('src/ai/prompt.ts')).toBe('src/ai/prompt.ts');
  });

  it('still allows safe external protocols', () => {
    expect(transcriptUrlTransform('https://nimbalyst.com/docs')).toBe(
      'https://nimbalyst.com/docs'
    );
  });

  it('still sanitizes dangerous protocols', () => {
    expect(transcriptUrlTransform('javascript:alert(1)')).toBe('');
  });

  // Tracker reference links (`nimbalyst://NIM-123`) were blanked by the default
  // transform (unknown protocol), so the tracker-chip check in the `a` renderer
  // never saw the href and the link opened a blank window on click.
  it('preserves nimbalyst:// tracker reference URNs', () => {
    expect(transcriptUrlTransform('nimbalyst://NIM-1315')).toBe(
      'nimbalyst://NIM-1315'
    );
  });
});
