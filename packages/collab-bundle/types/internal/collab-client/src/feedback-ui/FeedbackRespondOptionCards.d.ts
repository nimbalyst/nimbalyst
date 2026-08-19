/**
 * The pick-one question, rendered as preview cards.
 *
 * This is the one place the respond surface departs from the compose surface's
 * option rows, and the departure is structural rather than cosmetic. Compose
 * renders `WidgetOptionList` + `WidgetOptionRow`: a single column of horizontal
 * rows, indicator then label then description, sized to be skimmed. Here the
 * options are a grid of vertical cards -- a preview panel on top, the choice
 * beneath it -- and selection is carried by the card frame rather than by the
 * indicator alone.
 *
 * The reason is that "which of these three do you like" is a visual question. A
 * radio list answers it badly: it makes three designs look like three strings,
 * and it makes the option you can read fastest win.
 *
 * The preview panel is a seam, not a picture. The protocol's `singleSelect`
 * option carries id, label and description and nothing else, so there is no
 * artifact here to render honestly. A caller that has one -- a subject shared
 * alongside the request, a rendered thumbnail -- supplies `renderPreview`, and
 * without one the panel stays a neutral placeholder rather than inventing an
 * image the option never had.
 */
import React from 'react';
import type { FeedbackAskArtifact, StructuredInputSingleSelectOption } from '@nimbalyst/collab-protocol';
import type { FeedbackArtifactActionResolver } from './FeedbackArtifactSubjects';
/**
 * Returning nullish is a supported answer, not a failure: "I have a renderer,
 * and this particular artifact has nothing worth showing." The card then falls
 * through to the titled placeholder.
 */
export type FeedbackOptionPreviewRenderer = (option: StructuredInputSingleSelectOption, index: number, artifact?: FeedbackAskArtifact) => React.ReactNode;
export interface FeedbackRespondOptionCardsProps {
    askId: string;
    options: readonly StructuredInputSingleSelectOption[];
    /** Bound per-entry resources, keyed to option ids. */
    artifacts?: readonly FeedbackAskArtifact[];
    selectedId?: string;
    onSelect: (optionId: string) => void;
    disabled?: boolean;
    renderPreview?: FeedbackOptionPreviewRenderer;
    /**
     * Shown as an expand affordance on each preview when a caller can open one.
     * Only rendered for options that actually have an artifact to open -- an
     * expand button over a placeholder is a promise the card cannot keep.
     */
    onExpand?: (artifact: FeedbackAskArtifact) => void;
    resolveAction?: FeedbackArtifactActionResolver;
}
/**
 * The fallback, and it covers more than "no artifact". An artifact whose kind
 * has no registered editor, or one the host could not resolve, lands here too:
 * a titled card is honest about having nothing to show, where an empty scaled
 * frame looks like a preview that failed to load.
 */
export declare const FeedbackOptionPlaceholderPreview: React.FC<{
    label: string;
    artifactLabel?: string;
}>;
export declare const FeedbackRespondOptionCards: React.FC<FeedbackRespondOptionCardsProps>;
