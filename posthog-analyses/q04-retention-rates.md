# Question 4: Retention Rates Analysis

## Research Question

What are the 7-day, 30-day, and 90-day retention rates, and how do they differ between users who complete onboarding versus those who skip it, users who use AI features in their first session, and users who experience errors in their first three sessions?

## Analysis Limitations

**CRITICAL LIMITATION**: This analysis could not be completed as intended due to PostHog database performance constraints. All queries attempting to calculate retention rates resulted in 504 Gateway Timeout errors, even when:
- Filtering to small date ranges (7 days)
- Removing DISTINCT operations
- Using simple COUNT queries
- Avoiding cohort subqueries

The PostHog instance appears to have performance issues with large event tables that prevent complex retention analysis.

## Partial Data Available

### Session Activity Trends (Nov 14 - Dec 29, 2025)

From a trends query that successfully executed, we have:
- **Total session starts in period**: 4,474 events
- **Date range**: 2025-11-14 to 2025-12-29 (46 days)
- **Peak days**:
  - Dec 26: 548 sessions
  - Dec 19: 247 sessions
  - Dec 2: 218 sessions

### Onboarding Events

Basic count query (not filtered by cohort due to timeout issues):
- **Onboarding completed events** (Nov 14 - Dec 6): 61 events

### Time Windows for Retention Analysis

Given today's date (2026-01-05), the eligible cohorts would be:
- **7-day retention**: Users who started before 2025-12-29 (most of dataset)
- **30-day retention**: Users who started before 2025-12-06
- **90-day retention**: Users who started before 2025-10-07 (NOT POSSIBLE - tracking started 2025-11-14)

## Query Used (All Failed with Timeouts)

### Attempted Retention Query
```sql
-- This query timed out
WITH user_cohorts AS (
  SELECT
    person_id,
    min(timestamp) AS first_session
  FROM events
  WHERE event = 'nimbalyst_session_start'
    AND timestamp >= '2025-11-14'
    AND person_id NOT IN (
      SELECT person_id FROM cohort_people WHERE cohort_id = 200405
    )
  GROUP BY person_id
),
active_in_period AS (
  SELECT
    person_id,
    countIf(timestamp >= first_session + INTERVAL 7 DAY
      AND timestamp <= first_session + INTERVAL 14 DAY) AS active_week_2
  FROM events
  WHERE event = 'nimbalyst_session_start'
  GROUP BY person_id
)
SELECT
  countIf(active_week_2 > 0) * 100.0 / count(*) AS retention_7day
FROM user_cohorts
LEFT JOIN active_in_period USING (person_id)
WHERE first_session <= '2025-12-29'
```

### Attempted Onboarding Comparison
```sql
-- This query also timed out
SELECT
  COUNT(DISTINCT person_id) as onboarding_completed
FROM events
WHERE event = 'onboarding_completed'
  AND timestamp >= '2025-11-14'
  AND timestamp <= '2025-12-06'
```

## Raw Results

**NO RESULTS AVAILABLE** - All analytical queries failed with database timeout errors.

The only successful queries were:
1. Simple trends aggregation (provided 4,474 total sessions)
2. Basic event count without DISTINCT (61 onboarding events)
3. Test queries with literal values

## Takeaways

### 1. PostHog Performance Issues Prevent Retention Analysis

The PostHog instance cannot handle the queries required for retention analysis. This is a critical technical blocker that needs immediate attention.

**Impact**:
- Cannot calculate retention rates
- Cannot compare cohorts (onboarding vs non-onboarding)
- Cannot segment by user behavior (AI usage, errors)
- Cannot perform user-level analysis

### 2. Data Infrastructure Needs Optimization

**Probable causes of timeout issues**:
- Events table is not properly indexed for person_id queries
- Cohort membership lookups (cohort_people table) are expensive
- No materialization of user-level aggregates
- Query timeout limits are too aggressive for dataset size

### 3. Alternative Approaches Required

Since standard retention queries don't work, alternative approaches needed:
- **Use PostHog UI retention insights**: PostHog's built-in retention charts use optimized queries
- **Sample-based analysis**: Analyze a random 10% sample of users
- **Pre-aggregate data**: Create materialized views or export data for external analysis
- **Time-boxed queries**: Analyze one day at a time and combine results

### 4. Business Impact of Missing Retention Data

Without retention metrics, we cannot:
- **Assess product-market fit**: Retention is the #1 indicator of PMF
- **Validate onboarding effectiveness**: Can't compare completed vs skipped onboarding
- **Identify churn risks**: Can't detect users at risk of leaving
- **Measure feature impact**: Can't see if AI features drive retention
- **Calculate LTV**: Retention rates are required for customer lifetime value

This is a **critical gap** in analytics capability.

## Suggested Actions / Product Direction

### IMMEDIATE PRIORITY: Fix PostHog Performance

**Finding**: Cannot perform any user-level retention analysis due to database timeouts.

**Urgent Actions Required**:
1. **Contact PostHog support** about query performance issues
2. **Review PostHog plan limits** - may need to upgrade tier for query performance
3. **Enable query materialization** for person-level aggregates
4. **Index optimization** for person_id and cohort_id lookups
5. **Consider data export** to external warehouse (BigQuery, Snowflake) for complex analysis

### Alternative Analysis Methods (Temporary Workarounds)

**While fixing infrastructure**:

1. **Use PostHog UI Retention Tool**:
   - Go to Insights → Retention
   - Configure retention manually in UI (which uses optimized backend)
   - Export results as CSV
   - Manual but functional

2. **Sample-Based Analysis**:
   - Query random 5% of person_ids from a successful query
   - Perform retention analysis on sample only
   - Extrapolate to full population with confidence intervals

3. **Daily Batch Processing**:
   - Export events for one cohort day at a time
   - Process locally in Python/R
   - Combine results across cohort days

4. **Event-Based Proxies**:
   - Instead of user retention, measure "session retention"
   - Track: "What % of sessions on Day 0 have a session on Day 7?"
   - Less accurate but computable

### Architecture Recommendations

**For long-term solution**:

1. **Implement user-level aggregates table**:
   - Pre-calculate first_session, last_session, total_sessions per user
   - Update incrementally as new events arrive
   - Query this table instead of events table

2. **Create retention snapshots**:
   - Run retention calculation weekly as a batch job
   - Store results in separate table
   - Query snapshots instead of recalculating

3. **Consider dedicated analytics warehouse**:
   - Export PostHog events to BigQuery/Snowflake
   - Use dbt for transformation layer
   - PostHog for real-time, warehouse for complex analysis

### Data Governance

**Finding**: Cannot filter by cohort ID 200405 (test users) in queries.

**Recommendations**:
1. Mark test users with person property instead of cohort membership
2. Use `$set` to mark `is_test_user: true` on test accounts
3. Filter on property instead of cohort JOIN (much faster)
4. Alternatively, exclude test user events at ingestion time

## Confidence Level

**Zero (0%)** for any retention rate calculations.

### Why we have no confidence:
- **No data collected**: All analytical queries failed
- **Cannot verify methodology**: Unable to test query logic
- **Cannot check assumptions**: Can't examine user cohorts
- **No results to analyze**: Literally zero retention rate calculations succeeded

### What we DO know with confidence:
- PostHog query infrastructure cannot handle current analysis needs
- 4,474 session starts occurred between Nov 14 - Dec 29 (from trends query)
- 61 onboarding completed events occurred before Dec 6 (from basic count)
- Query performance is the blocker, not data availability

## Recommended Follow-up Analysis

**BEFORE attempting any follow-up analysis, the PostHog performance issues MUST be resolved.**

Once resolved, priority analyses should be:

1. **Basic retention rates**: 7-day, 30-day retention for all users
2. **Onboarding impact**: Compare retention: completed vs skipped/deferred
3. **AI feature correlation**: Retention of users who created AI session in first session vs those who didn't
4. **Error impact**: Retention of users who experienced errors in first 3 sessions vs error-free users
5. **Cohort analysis**: Weekly cohorts to track retention trend over time
6. **Power user identification**: Define power user based on retention + engagement

## Technical Appendix: Error Messages

All queries resulted in:
```
Status Code: 504 (Gateway Timeout)
Error Message: {
  "type": "server_error",
  "code": "error",
  "detail": "Query has hit the max execution time before completing.
            See our docs for how to improve your query performance.
            You may need to materialize.",
  "attr": null
}
```

Queries that failed:
- User cohort identification with cohort filter
- User cohort identification without cohort filter
- Simple DISTINCT person_id counts
- Event counts grouped by event type
- Any query with date range filters on events table

Only queries that succeeded:
- Trends query (aggregated by day, person_id not selected)
- Simple COUNT(*) without DISTINCT or GROUP BY
- Literal value queries
