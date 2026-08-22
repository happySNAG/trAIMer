# Aldo Aim Lab

A Fortnite-focused aim testing and sensitivity optimization system.

## V1 goals

- Establish a baseline from the player's current Fortnite sensitivity.
- Support 800 DPI initially, while keeping DPI configurable.
- Test flicking, target acquisition, micro-correction, and moving-target tracking.
- Test multiple target sizes, distances, angles, directions, and speeds.
- Collect raw trial data rather than relying only on aggregate scores.
- Measure:
  - hit accuracy
  - reaction time
  - time to target
  - overshoot
  - undershoot
  - correction distance
  - correction count
  - tracking error
  - target-switch latency
  - consistency / variance
- Run repeated trials to reduce noise.
- Search sensitivities around the player's baseline.
- Recommend Fortnite X/Y sensitivity and calculate eDPI.
- Report confidence in recommendations.
- Explain why a sensitivity was selected.
- Store historical sessions and allow comparison over time.
- Keep the measurement / optimization engine independent from the UI.

## Architecture principle

The aim-testing engine, data model, statistics, optimizer, and automated tests
must not depend on the eventual visual design. Claude Code will later own the
production UI design.

## Initial player profile

Player: Aldo
Game: Fortnite
Mouse: Logitech Lightspeed wireless
DPI: 800
Preference: medium sensitivity
