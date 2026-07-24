/**
 * Tip: DataModelLM Discovery
 *
 * Surfaces visual ER/Prisma editing to users active enough to be writing
 * raw SQL or thinking about schemas.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const SchemaIcon = <MaterialSymbol icon="schema" size={16} />;

export const datamodelDiscoverTip: TipDefinition = {
  id: 'tip-datamodel-discover',
  name: 'DataModelLM Discovery',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED_WITH_TOOLS, 5) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.DATAMODEL_OPENED),
    delay: 2000,
    priority: 4,
  },
  content: {
    icon: SchemaIcon,
    title: 'Design schemas visually with DataModelLM',
    body: 'A **.datamodel** file is a Prisma-style schema with a live ER diagram. The agent can edit it like any source file, and you get the diagram for free.',
  },
};
