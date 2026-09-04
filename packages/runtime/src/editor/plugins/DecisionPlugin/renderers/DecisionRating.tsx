/**
 * `rating`, in both states.
 *
 * The scale is the feedback surface's control: one target per step from `min`
 * to `max`, with the end labels beside it.
 *
 * The answered state adds a distribution histogram with the viewer's own column
 * called out, because the mean alone hides the shape that matters -- a 3.0 from
 * everybody agreeing and a 3.0 from a even split are different facts and demand
 * different conclusions. This is also why sealing a rating takes a written
 * sentence rather than the number: a 3.7 average is a reading, and the outcome
 * is what the team is doing about the reading.
 */

import React from "react";
import type {
  DecisionBlockSource,
  DecisionRatingTally,
  FeedbackAnswer,
} from "@nimbalyst/collab-protocol";
import { decisionRatingScaleValues } from "@nimbalyst/collab-protocol";

interface RatingProps {
  source: DecisionBlockSource;
  draft: FeedbackAnswer | undefined;
  onDraftChange: (answer: FeedbackAnswer) => void;
  disabled: boolean;
  tally: DecisionRatingTally | null;
}

export const DecisionRating: React.FC<RatingProps> = ({
  source,
  draft,
  onDraftChange,
  disabled,
  tally,
}) => {
  const steps = decisionRatingScaleValues(source);
  const value = draft?.type === "rating" ? draft.value : undefined;
  const peak = tally
    ? Math.max(1, ...tally.distribution.map((bucket) => bucket.count))
    : 1;

  return (
    <div className="decision-rating">
      <div className="decision-scale-row">
        {source.minLabel ? (
          <span className="decision-scale-end">{source.minLabel}</span>
        ) : null}
        <span className="decision-scale">
          {steps.map((step) => (
            <button
              key={step}
              type="button"
              className={`decision-pip${
                value === step ? " decision-pip--mine" : ""
              }`}
              onClick={() => onDraftChange({ type: "rating", value: step })}
              disabled={disabled}
              aria-pressed={value === step}
              data-value={step}
              data-testid="decision-rating-step"
            >
              {step}
            </button>
          ))}
        </span>
        {source.maxLabel ? (
          <span className="decision-scale-end">{source.maxLabel}</span>
        ) : null}
      </div>

      {tally ? (
        <>
          <div className="decision-histo" aria-hidden="true">
            {tally.distribution.map((bucket) => (
              <span
                key={bucket.value}
                className={`decision-hcol${
                  tally.viewerValue === bucket.value
                    ? " decision-hcol--mine"
                    : ""
                }`}
              >
                <span
                  className="decision-hbar"
                  style={{
                    height: `${Math.round((bucket.count / peak) * 30)}px`,
                  }}
                />
                <span className="decision-hnum">{bucket.count}</span>
              </span>
            ))}
          </div>
          <div className="decision-avg">
            <b>{`${tally.mean.toFixed(1)} average`}</b>
            {` · ${tally.respondentCount} rated`}
            {tally.viewerValue !== undefined
              ? ` · you rated ${tally.viewerValue}`
              : ""}
          </div>
        </>
      ) : null}
    </div>
  );
};
