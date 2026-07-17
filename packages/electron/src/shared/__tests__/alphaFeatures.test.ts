import { describe, expect, it } from "vitest";
import {
  ALPHA_FEATURES,
  getAlphaFeatureDefinition,
  getDefaultAlphaFeatures,
} from "../alphaFeatures";

describe("alpha feature registry", () => {
  it("defaults every registered feature to disabled", () => {
    const defaults = getDefaultAlphaFeatures();
    for (const feature of ALPHA_FEATURES) {
      expect(defaults[feature.tag]).toBe(false);
      expect(getAlphaFeatureDefinition(feature.tag)?.name).toBeTruthy();
    }
  });

  it("no longer registers the shipped offline-collab-replicas flag", () => {
    expect(getAlphaFeatureDefinition("offline-collab-replicas")).toBeUndefined();
  });
});
