import { type ReactNode } from 'react';
import type { CollabOpenOptions } from '../../core';
import { type PlacedViewScope } from '../../../../runtime/src/core/placedViewUrl';
import type { NamedPageViewsController } from '../../../../runtime/src/editor/plugins/EmbedPlugin/namedPageViewsController';
import type { PlacedViewHandoff } from './placedViewHandoff';
export declare function TypePageViews({ typeId, controller, temporaryView, onClearTemporaryView, onPrepareDocument, scope, onOpenItem, children }: {
    typeId: string;
    controller?: NamedPageViewsController | null;
    temporaryView?: PlacedViewHandoff | null;
    onClearTemporaryView?: () => void;
    onPrepareDocument?: () => Promise<void>;
    scope?: PlacedViewScope;
    onOpenItem: (id: string, options?: CollabOpenOptions) => void;
    children: ReactNode;
}): import("react").JSX.Element;
