---
title: Falcon 9 Rocket Equation
display:
  decimals: 1
---
# Falcon 9 Rocket Equation
// Approximate Falcon 9 Block 5 numbers for a simple two-stage ideal rocket model.
// Change payload to see how the upper-stage burn changes.

## Mission Inputs
payload = 15500 kg
target_orbit_delta_v = 9400 m / s

## Vehicle Assumptions
// Masses are approximate and meant for a readable demo, not mission planning.
g0 = 9.80665 m / s^2
stage1_dry_mass = 25600 kg
stage1_propellant = 409500 kg
stage1_isp = 282 s
stage2_dry_mass = 4000 kg
stage2_propellant = 107500 kg
stage2_isp = 348 s

## Stage 1 Burn
stage1_initial_mass = stage1_dry_mass + stage1_propellant + stage2_dry_mass + stage2_propellant + payload
stage1_final_mass = stage1_dry_mass + stage2_dry_mass + stage2_propellant + payload
stage1_delta_v = to(stage1_isp * g0 * log(stage1_initial_mass / stage1_final_mass), "m / s")
stage1_propellant_burned = stage1_propellant

## Stage 2 Burn
stage2_initial_mass = stage2_dry_mass + stage2_propellant + payload
stage2_delta_v_needed = target_orbit_delta_v - stage1_delta_v
stage2_final_mass_after_burn = stage2_initial_mass / exp(stage2_delta_v_needed / (stage2_isp * g0))
stage2_propellant_burned = stage2_initial_mass - stage2_final_mass_after_burn
stage2_propellant_remaining = stage2_propellant - stage2_propellant_burned
stage2_burn_fraction = stage2_propellant_burned / stage2_propellant -> percent(1)

## Mission Check
// Try payload values like 12000 kg, 15500 kg, and 22000 kg.
payload_fraction_of_liftoff_mass = payload / stage1_initial_mass -> percent(2)
assert stage2_propellant_remaining > 0 kg
assert stage2_burn_fraction < 1
