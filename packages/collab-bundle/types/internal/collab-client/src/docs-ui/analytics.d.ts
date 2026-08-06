import type { CollabHost } from '../core/index';
export declare function bucketItemCount(count: number): '0' | '1' | '2-5' | '6-20' | '21+';
export declare function bucketQueryLength(length: number): '1-3' | '4-10' | '11-30' | '31+';
export declare function stableCategory(value: string | null | undefined): string;
export declare function trackDocumentAction(host: CollabHost, params: {
    action: string;
    documentType: string | null | undefined;
    entryPoint: string;
}): void;
