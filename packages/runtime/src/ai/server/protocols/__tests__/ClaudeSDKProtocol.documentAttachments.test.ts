import { describe, it, expect } from 'vitest';
import { ClaudeSDKProtocol } from '../ClaudeSDKProtocol';

// Regression coverage for nimbalyst#239. Text-file attachments dragged into
// the agent chat used to send only the literal `@filename` token. The agent
// then tried to resolve the filename as a path and replied "file does not
// exist." Root cause: buildDocumentBlocks only handled `type: 'pdf'`, so
// `type: 'document'` was silently dropped. Image attachments worked
// throughout (different code path). The fix mirrors the working claude-code
// path in messagePreparation.ts: emit a text-source document block carrying
// the decoded file contents.

describe('ClaudeSDKProtocol document attachments (issue #239)', () => {
  // buildDocumentBlocks is private; cast through unknown to exercise it
  // directly without spinning up the full SDK session.
  const proto = new ClaudeSDKProtocol() as unknown as {
    buildDocumentBlocks(attachments?: any[]): any[];
  };

  it('emits a text-source document block for type: document attachments', () => {
    const fileText = 'line one\nline two\nline three\n';
    const blocks = proto.buildDocumentBlocks([
      {
        type: 'document',
        filename: 'notes.txt',
        base64Data: Buffer.from(fileText).toString('base64'),
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: fileText,
      },
      title: 'notes.txt',
    });
  });

  it('preserves the existing pdf base64 path', () => {
    // The pdf branch must keep its base64-source shape so PDFs are not
    // accidentally routed through the text decoder, which would corrupt
    // binary contents.
    const pdfBase64 = Buffer.from('%PDF-1.4 fake-pdf-bytes').toString('base64');
    const blocks = proto.buildDocumentBlocks([
      {
        type: 'pdf',
        filename: 'doc.pdf',
        base64Data: pdfBase64,
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBase64,
      },
      title: 'doc.pdf',
    });
  });

  it('handles mixed pdf and document attachments in one batch', () => {
    const textContent = 'hello world';
    const pdfBase64 = Buffer.from('%PDF-1.4').toString('base64');
    const blocks = proto.buildDocumentBlocks([
      { type: 'pdf', filename: 'a.pdf', base64Data: pdfBase64 },
      { type: 'document', filename: 'b.txt', base64Data: Buffer.from(textContent).toString('base64') },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].source.type).toBe('base64');
    expect(blocks[0].source.media_type).toBe('application/pdf');
    expect(blocks[1].source.type).toBe('text');
    expect(blocks[1].source.media_type).toBe('text/plain');
    expect(blocks[1].source.data).toBe(textContent);
  });

  it('falls back to a default title when filename is missing', () => {
    const blocks = proto.buildDocumentBlocks([
      {
        type: 'document',
        base64Data: Buffer.from('x').toString('base64'),
      },
    ]);

    expect(blocks[0].title).toBe('document.txt');
  });

  it('returns an empty array when no attachments are passed', () => {
    expect(proto.buildDocumentBlocks(undefined)).toEqual([]);
    expect(proto.buildDocumentBlocks([])).toEqual([]);
  });

  it('skips document attachments that have no base64Data', () => {
    // Guard against AttachmentProcessor edge cases where a large-document
    // attachment was diverted to a tmp file and inline base64Data is absent.
    // The protocol must not emit a malformed text block in that case.
    const blocks = proto.buildDocumentBlocks([
      { type: 'document', filename: 'big.txt' },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it('survives a malformed base64 payload without throwing', () => {
    // Buffer.from with base64 is lenient and never throws for ascii input,
    // but the decode wrapper catches errors as a defensive measure. Verify
    // the protocol degrades to "skip the attachment" rather than crashing
    // the whole turn.
    const blocks = proto.buildDocumentBlocks([
      { type: 'document', filename: 'notes.txt', base64Data: '!!!not-real-base64!!!' },
    ]);
    // Buffer.from is lenient, so we still get a (possibly garbled) block,
    // but the test asserts no exception propagates.
    expect(blocks.length).toBeLessThanOrEqual(1);
  });
});
