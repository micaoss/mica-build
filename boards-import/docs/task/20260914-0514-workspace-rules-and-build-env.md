# 20260914-0514-workspace-rules-and-build-env Workspace rules and the released build-env

- **status**: review
- **priority**: P1
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-14 05:14

## Description

Bring mica-boards to the workspace Constraints and mica-build-env RULES.md at
release 20260914-0128: the build-env lock instead of the build-env/ source
pin, owned packaging and publish scripts, time-named releases, ci.yml and
release.yml with native per-architecture jobs, no retired-repository
references. Plan: docs/plan/20260914-0514-workspace-rules-and-build-env.md.

## ActiveForm

Bringing mica-boards to the workspace rules and the released build-env

## Dependencies

- **blocked by**: (none)
- **blocks**: mica-build adoption of the board artifacts

## Notes

2026-09-14 05:14: builds on branch split-boot-inputs (d1a5f3e, the mica-boot split).

2026-09-14 07:15: families/ merged into the boards, radio packages received, organisation references moved to micaoss; the repository history becomes one root commit (user decision) pushed to micaoss/mica-boards.
