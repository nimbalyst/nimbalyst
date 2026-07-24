/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  setupMarkdownDiffTest,
} from '../../utils/diffTestUtils';

describe('HomeKit Spec Diff', () => {
  test('Replace MVP Scope with Accessory Types and MVP Scope', () => {
    const originalMarkdown = `# Jarvis

## Jarvis HomeKit Monitor - App Specification

### Core Architecture
- Platform: Mac Catalyst app (enables HomeKit framework access)
- Database: Embedded SQLite for timeseries data
- UI Framework: SwiftUI with real-time updates

### Key Features

#### HomeKit Integration
- Discover and monitor all HomeKit/Matter accessories
- Real-time state monitoring (lights, thermostats, sensors, etc.)
- Capture state changes with timestamps
- Support for scenes and automation triggers

#### Data Management
- Continuous logging of accessory states to embedded SQLite DB
- Configurable sampling rates per device type
- Data retention policies (e.g., high-res for 7 days, hourly averages for 1 year)
- Export capabilities for historical data

#### Visualization
- Real-time dashboard with current home status
- Upload a flooplan to map rooms for current status 
- Interactive time-series graphs for each accessory
- Customizable date ranges and aggregation levels
- Overlay multiple devices on single charts
- Heat maps for usage patterns

#### Smart Features
- Anomaly detection for unusual patterns
- Energy usage analytics
- Predictive insights based on historical data
- Custom alerts for specific conditions

### Technical Stack
- Frontend: SwiftUI, SwiftCharts framework
- Backend: Combine for reactive data flow
- Database: Embedded SQLite with cloud backup option
- Networking: HomeKit framework, Bonjour discovery

### MVP Scope
1. HomeKit device discovery and monitoring
2. Basic timeseries data collection
3. Simple dashboard with current states
4. Historical graphs for temperature and lighting
5. Data export functionality




Looking at your app's core functionality - HomeKit monitoring, data visualization, and smart analytics - here are some name suggestions organized by theme:

## Smart/Intelligence Theme

## Monitoring/Watching Theme


## Data/Analytics Theme


## Creative/Unique Theme


## Personal Favorites
I'd lean toward **HomeIQ** or **HomePulse** - they're memorable, suggest the key value proposition (intelligence/real-time monitoring), and work well as app names.

What resonates with you, or does this spark any other ideas?`;

    const newMarkdown = `# Jarvis

## Jarvis HomeKit Monitor - App Specification

### Core Architecture
- Platform: Mac Catalyst app (enables HomeKit framework access)
- Database: Embedded SQLite for timeseries data
- UI Framework: SwiftUI with real-time updates

### Key Features

#### HomeKit Integration
- Discover and monitor all HomeKit/Matter accessories
- Real-time state monitoring (lights, thermostats, sensors, etc.)
- Capture state changes with timestamps
- Support for scenes and automation triggers

#### Data Management
- Continuous logging of accessory states to embedded SQLite DB
- Configurable sampling rates per device type
- Data retention policies (e.g., high-res for 7 days, hourly averages for 1 year)
- Export capabilities for historical data

#### Visualization
- Real-time dashboard with current home status
- Upload a flooplan to map rooms for current status 
- Interactive time-series graphs for each accessory
- Customizable date ranges and aggregation levels
- Overlay multiple devices on single charts
- Heat maps for usage patterns

#### Smart Features
- Anomaly detection for unusual patterns
- Energy usage analytics
- Predictive insights based on historical data
- Custom alerts for specific conditions

### Technical Stack
- Frontend: SwiftUI, SwiftCharts framework
- Backend: Combine for reactive data flow
- Database: Embedded SQLite with cloud backup option
- Networking: HomeKit framework, Bonjour discovery

### Accessory Types & Key Metrics

- **Lighting**
    - On/off state
    - Brightness level (0-100%)
    - Color temperature (warm/cool)
    - RGB color values
    - Power consumption estimates

- **Climate Control**
    - Current temperature
    - Target temperature
    - Heating/cooling mode
    - Fan speed
    - Humidity levels
    - Energy usage patterns

- **Security & Sensors**
    - Motion detection events
    - Door/window open/closed state
    - Contact sensor triggers
    - Camera activity/recordings
    - Battery levels
    - Signal strength

- **Switches & Outlets**
    - On/off state
    - Power consumption (if smart outlet)
    - Usage duration
    - Scheduling patterns

- **Entertainment & Media**
    - Power state
    - Volume levels
    - Input source
    - Playing/paused state
    - Usage time tracking

- **Environmental Sensors**
    - Air quality index
    - CO2 levels
    - Humidity readings
    - Light levels (lux)
    - Noise levels
    - Leak detection

- **Locks & Access**
    - Locked/unlocked state
    - Access events (who/when)
    - Battery levels
    - Auto-lock status
    - Usage frequency

### MVP Scope
1. HomeKit device discovery and monitoring
2. Basic timeseries data collection
3. Simple dashboard with current states
4. Historical graphs for temperature and lighting
5. Data export functionality




Looking at your app's core functionality - HomeKit monitoring, data visualization, and smart analytics - here are some name suggestions organized by theme:

## Smart/Intelligence Theme

## Monitoring/Watching Theme


## Data/Analytics Theme


## Creative/Unique Theme


## Personal Favorites
I'd lean toward **HomeIQ** or **HomePulse** - they're memorable, suggest the key value proposition (intelligence/real-time monitoring), and work well as app names.

What resonates with you, or does this spark any other ideas?`;

    // Test diff application and approval/rejection
    const result = setupMarkdownDiffTest(originalMarkdown, newMarkdown);

    // Test that approving the diff produces the target markdown
    assertApproveProducesTarget(result);

    // Test that rejecting the diff produces the original markdown
    assertRejectProducesOriginal(result);

    // Verify we have diff nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThanOrEqual(0);
  });


});
