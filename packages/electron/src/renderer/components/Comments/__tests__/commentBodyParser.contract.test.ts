import { describe, expect, it } from 'vitest';

import { COMMENT_BODY_CONTRACT_CORPUS } from '../../../../../../collab-protocol/src/__tests__/commentBodyContractCorpus';
import { parseCommentBody, segmentsToPlainText } from '../commentBodyParser';
import { createCommentFixtures } from '../commentFixtures';
import { resourceRefToUrn } from '../resourceUrn';
import type { ResourcePillView } from '../commentTypes';

describe('comment body protocol contract', () => {
  it.each(COMMENT_BODY_CONTRACT_CORPUS)('$name', (fixture) => {
    const comments = createCommentFixtures();
    const pills = Object.fromEntries(
      fixture.resourceRefs.map((ref) => {
        const urn = resourceRefToUrn(ref);
        const pill: ResourcePillView = {
          urn,
          kind: ref.kind,
          availability: 'available',
          icon: 'link',
          label: ref.sourceId,
          actionable: true,
        };
        return [urn, pill];
      }),
    );

    const segments = parseCommentBody(fixture.body, {
      resourceRefs: fixture.resourceRefs,
      mentionedUserIds: fixture.deliveryHints.mentionedUserIds,
      mentionedAgentSessionIds: fixture.deliveryHints.mentionedAgentSessionIds,
      directory: comments.directory,
      viewerUserId: comments.viewerUserId,
      pills,
    });

    expect(segmentsToPlainText(segments)).toBe(fixture.expectedPlainText);
  });
});
