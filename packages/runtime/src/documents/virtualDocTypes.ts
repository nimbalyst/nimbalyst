/**
 * Types and interfaces for virtual documents
 */

export interface VirtualDocument {
  id: string;
  path: string; // virtual:// path
  title: string;
  content: string;
  isVirtual: true;
  metadata?: {
    description?: string;
    createdAt?: string;
    [key: string]: any;
  };
}

export interface VirtualDocumentDescriptor {
  id: string;
  title: string;
  assetPath: string; // Path to bundled asset
  virtualPath: string; // virtual:// URL
}

export type VirtualDocumentState = {
  isVirtual: boolean;
  virtualId?: string;
  warningDismissed?: boolean;
};