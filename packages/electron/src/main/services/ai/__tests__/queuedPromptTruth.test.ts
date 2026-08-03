import { describe, expect, it } from 'vitest';
import { createQueuedPromptTruth, payloadReceiptsMatch, receiptQueuedPromptPayload } from '../queuedPromptTruth';

describe('queued prompt payload truth', () => {
  it('receipts paired same-millisecond bracket rows without final-character loss', () => {
    const left = createQueuedPromptTruth({ queueRowId: 'row-left', sourceSessionId: 'session', producer: 'composer', payload: '[ex-CC' });
    const right = createQueuedPromptTruth({ queueRowId: 'row-right', sourceSessionId: 'session', producer: 'composer', payload: '[ex-CC]' });
    expect(left.clientSubmissionId).not.toBe(right.clientSubmissionId);
    expect(left.payload.unicodeScalars).toBe(6);
    expect(right.payload.unicodeScalars).toBe(7);
    expect(left.payload.sha256).not.toBe(right.payload.sha256);
  });

  it('preserves whitespace, emoji, CRLF/LF and a final newline exactly', () => {
    const payload = ' leading 😀\r\nline\n';
    const receipt = receiptQueuedPromptPayload(payload);
    expect(receipt.utf8Bytes).toBe(Buffer.from(payload, 'utf8').byteLength);
    expect(receipt.unicodeScalars).toBe(Array.from(payload).length);
    expect(payloadReceiptsMatch(payload, receipt)).toBe(true);
    expect(payloadReceiptsMatch(payload.trim(), receipt)).toBe(false);
  });
});
