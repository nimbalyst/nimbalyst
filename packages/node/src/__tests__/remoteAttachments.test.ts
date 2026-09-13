// @vitest-environment node
import {readFile, access} from 'node:fs/promises';
import {describe, it, expect} from 'vitest';
import {stageRemoteAttachments} from '../serve/remoteAttachments.js';

describe('remote attachment staging', () => {
  it('decrypts the iOS envelope, confines filenames, cleans up and refuses a bad envelope', async () => {
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('attached document');
    const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, data);
    const envelope = {id: 'a', filename: '../../secret.txt', mimeType: 'text/plain', size: data.length, encryptedData: Buffer.from(encrypted).toString('base64'), iv: Buffer.from(iv).toString('base64')};
    const staged = await stageRemoteAttachments([envelope], key);
    expect(await readFile(staged.attachments[0].filepath, 'utf8')).toBe('attached document');
    expect(staged.attachments[0].filename).toBe('secret.txt');
    await staged.dispose();
    await expect(access(staged.attachments[0].filepath)).rejects.toThrow();
    await expect(stageRemoteAttachments([{...envelope, size: 1}], key)).rejects.toThrow('size');
    const wrongKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    await expect(stageRemoteAttachments([envelope], wrongKey)).rejects.toThrow();
  });
});
