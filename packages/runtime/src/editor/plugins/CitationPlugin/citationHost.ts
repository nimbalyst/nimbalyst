/**
 * Host hooks for citation chips. The desktop fills these so a human citation
 * jumps to its session (where that session exists on this device) and a
 * source opens. With nothing set, the popover shows the snapshot only.
 */

import type { HumanCitation } from '../../../core/citationSyntax';

export interface CitationHost {
  /** Whether this device can open the cited session. */
  canOpenHumanCitation?: (citation: HumanCitation) => boolean;
  openHumanCitation?: (citation: HumanCitation) => void;
  /** Opens a web URL or a document reference. */
  openSource?: (target: string) => void;
}

let host: CitationHost = {};

export function setCitationHost(next: CitationHost | undefined): void {
  host = next ?? {};
}

export function getCitationHost(): CitationHost {
  return host;
}
