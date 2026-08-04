---
title: Launch Metrics
display:
  decimals: 1
---
# Launch Metrics
// These assumptions mirror revenue.csv. Change a value to see every dependent result update.

## Revenue
january_revenue = 43400 -> currency(USD, 0)
june_revenue = 82600 -> currency(USD, 0)
six_month_total = 43400 + 48900 + 55400 + 63500 + 72500 + 82600 -> currency(USD, 0)
average_monthly_revenue = six_month_total / 6 -> currency(USD, 0)
six_month_growth = (june_revenue / january_revenue) - 1 -> percent(1)

## Launch Target
launch_target = 85000 -> currency(USD, 0)
target_gap = launch_target - june_revenue -> currency(USD, 0)
target_attainment = june_revenue / launch_target -> percent(1)

## Customer Momentum
january_new_customers = 18
june_new_customers = 39
customer_growth = (june_new_customers / january_new_customers) - 1 -> percent(1)
revenue_per_new_customer = june_revenue / june_new_customers -> currency(USD, 0)

## Readiness Check
assert june_revenue > january_revenue
assert target_gap > 0
assert target_attainment > 0.9
