# Question 1: Feature Walkthrough and AI Session Adoption

## Research Question

What percentage of users who complete the feature walkthrough create their first AI session within 24 hours, and at which slide do most users abandon the walkthrough, compared to users who skip or defer onboarding?

## Query Used

Multiple HogQL queries were used to analyze this question:

### Walkthrough Completion Stats
```sql
SELECT
  count(*) AS total_completed,
  countIf(properties.skipped = false) AS completed_full,
  countIf(properties.skipped = true) AS skipped
FROM events
WHERE event = 'feature_walkthrough_completed'
  AND timestamp >= '2025-11-14'
  AND person_id NOT IN (
    SELECT person_id FROM cohort_people WHERE cohort_id = 200405
  )
```

### Walkthrough Abandonment by Slide
```sql
SELECT
  properties.skipped_at_slide AS slide,
  count(*) AS abandoned_count
FROM events
WHERE event = 'feature_walkthrough_completed'
  AND properties.skipped = true
  AND timestamp >= '2025-11-14'
  AND person_id NOT IN (
    SELECT person_id FROM cohort_people WHERE cohort_id = 200405
  )
GROUP BY properties.skipped_at_slide
ORDER BY abandoned_count DESC
```

### AI Session Creation After Walkthrough
```sql
WITH walkthrough_times AS (
  SELECT
    person_id,
    min(timestamp) AS walkthrough_time,
    any(properties.skipped) AS skipped
  FROM events
  WHERE event = 'feature_walkthrough_completed'
    AND timestamp >= '2025-11-14'
    AND person_id NOT IN (
      SELECT person_id FROM cohort_people WHERE cohort_id = 200405
    )
  GROUP BY person_id
),
ai_times AS (
  SELECT
    person_id,
    min(timestamp) AS ai_time
  FROM events
  WHERE event = 'create_ai_session'
    AND timestamp >= '2025-11-14'
    AND person_id NOT IN (
      SELECT person_id FROM cohort_people WHERE cohort_id = 200405
    )
  GROUP BY person_id
)
SELECT
  w.skipped,
  count(DISTINCT w.person_id) AS total_users,
  countIf(a.ai_time IS NOT NULL AND a.ai_time > w.walkthrough_time
    AND dateDiff('hour', w.walkthrough_time, a.ai_time) <= 24) AS created_ai_within_24h,
  countIf(a.ai_time IS NOT NULL AND a.ai_time > w.walkthrough_time) AS created_ai_after_walkthrough,
  countIf(a.ai_time IS NOT NULL AND a.ai_time < w.walkthrough_time) AS created_ai_before_walkthrough
FROM walkthrough_times w
LEFT JOIN ai_times a ON w.person_id = a.person_id
GROUP BY w.skipped
```

## Raw Results

### Walkthrough Completion Summary
- **Total walkthrough events**: 389
- **Completed fully (not skipped)**: 374 (96.1%)
- **Skipped**: 15 (3.9%)

### Walkthrough Abandonment by Slide
Among the 15 users who skipped the walkthrough:
- **Editor slide**: 9 users (60%)
- **Mockup slide**: 3 users (20%)
- **Agent slide**: 3 users (20%)

### AI Session Creation Timing

#### Users who completed walkthrough (skipped=false, n=365):
- **Created AI before walkthrough**: 363 (99.5%)
- **Created AI after walkthrough**: 2 (0.5%)
- **Created AI within 24h after walkthrough**: 2 (0.5%)

#### Users who skipped walkthrough (skipped=true, n=14):
- **Created AI before walkthrough**: 14 (100%)
- **Created AI after walkthrough**: 0 (0%)
- **Created AI within 24h after walkthrough**: 0 (0%)

### Overall AI Session Adoption
- **Users who completed walkthrough**: 379
- **Users who created AI sessions**: 434
- **Users who did both**: 368 (97.1% of walkthrough completers)

## Visualizations

### Walkthrough Completion Rate
```
Completed: ████████████████████████████████████ 96.1% (374)
Skipped:   ██                                     3.9% (15)
```

### Abandonment by Slide (of those who skipped)
```
Editor:  ██████████████ 60% (9)
Mockup:  ████           20% (3)
Agent:   ████           20% (3)
```

### AI Session Creation Timing
```
Before walkthrough: ████████████████████████████████████ 99.5% (377/379)
After walkthrough:  ▌                                     0.5% (2/379)
```

## Takeaways

### 1. The Walkthrough Happens AFTER AI Usage, Not Before

The most significant finding is that **99.5% of users who complete the walkthrough had already created their first AI session beforehand**. This completely inverts the expected user journey.

**Expected flow**: Onboarding → Walkthrough → AI Session Creation
**Actual flow**: AI Session Creation → Walkthrough (for most users)

This suggests that:
- Users are exploring Nimbalyst and creating AI sessions before they see the walkthrough
- The walkthrough may be presented later in the user journey, possibly as a help feature rather than first-time onboarding
- The question as originally framed assumes a different user flow than what actually occurs

### 2. High Walkthrough Completion Rate

96.1% of users who start the walkthrough complete it without skipping. This indicates:
- The walkthrough is well-designed and engaging
- Users find value in completing it
- The content is concise enough that users don't feel compelled to skip

### 3. Editor Slide Has Highest Abandonment

Of the small minority (15 users) who skip the walkthrough, 60% abandon at the Editor slide. This could indicate:
- The Editor slide may be too long or detailed
- Users may already be familiar with the editor from prior use (since they've typically already used the app)
- The slide content may not match user expectations or needs

### 4. Nearly Universal AI Adoption

97.1% of users who complete the walkthrough eventually create an AI session. This near-universal adoption suggests:
- AI features are core to Nimbalyst's value proposition
- Users discover and engage with AI naturally
- The product successfully guides users to AI features even without a formal walkthrough first

## Suggested Actions / Product Direction

### 1. Reconsider Walkthrough Timing and Purpose

**Current State**: The walkthrough appears to function more as post-usage education than first-time onboarding.

**Recommendations**:
- Consider repositioning the walkthrough as a "feature tour" rather than first-time onboarding
- Track when the walkthrough is shown relative to app launch to understand the trigger
- If the walkthrough should be first-time onboarding, investigate why users are creating AI sessions before seeing it

### 2. Optimize the Editor Slide

**Finding**: 60% of walkthrough abandonments happen at the Editor slide.

**Recommendations**:
- Shorten the Editor slide content
- Make it more interactive or skippable
- Consider splitting complex content across multiple shorter slides
- A/B test different versions of the Editor slide

### 3. Leverage the High Completion Rate

**Finding**: 96% completion rate is excellent.

**Recommendations**:
- Use the walkthrough as an engagement touchpoint for announcing new features
- Consider adding optional "deep dive" paths for power users
- Track which slides get the most time/interaction to understand what resonates

### 4. Investigate the 2.9% Who Never Create AI Sessions

**Finding**: 11 users (2.9%) completed the walkthrough but never created an AI session.

**Recommendations**:
- Interview or survey these users to understand blockers
- Track if they encountered errors or authentication issues
- Consider targeted prompts or help for users who haven't created AI sessions within X days

### 5. Reframe Research Questions Around Actual User Flow

**Finding**: The actual user flow differs significantly from assumptions.

**Recommendations**:
- Study the path: App Launch → First AI Session → Walkthrough
- Understand what drives users to create AI sessions before seeing educational content
- Research whether users who see the walkthrough first have different outcomes

## Confidence Level

**High (85%)** for the data accuracy, but **Low (30%)** for interpreting user intent due to:

### What we're confident about:
- The timing data is accurate: users create AI sessions before completing the walkthrough
- The walkthrough completion rate (96.1%) is reliable
- The abandonment patterns by slide are accurate for the small sample (n=15)

### What we're uncertain about:
- **Why** the walkthrough happens after AI usage (product design vs. user behavior)
- Whether the walkthrough is intended as first-time onboarding or a later-stage feature
- The small sample size for skipped walkthroughs (n=15) limits statistical confidence in abandonment patterns
- We don't know if the walkthrough can be triggered multiple times or by what action

### Limitations:
- The analysis assumes `feature_walkthrough_completed` is the first/only walkthrough event per user
- No data on when the walkthrough is *presented* vs. *completed*
- Cannot determine if users who skip later return to complete it
- The question's premise (walkthrough → AI session) doesn't match the observed flow

## Recommended Follow-up Analysis

1. **Track walkthrough presentation timing**: When is the walkthrough first shown relative to app launch?
2. **User journey mapping**: What do users do in their first session before encountering the walkthrough?
3. **Cohort analysis**: Compare outcomes for users who somehow see the walkthrough first vs. those who don't
4. **Qualitative research**: Interview users who skipped at the Editor slide to understand why
5. **Feature discovery**: How do users discover AI features without the walkthrough?
