# Session resume / recovery (Pass 4)

## Checkpoint contract

`ResumeCheckpoint` (`src/session/resume.ts`, inner schemaVersion 2, persisted
under envelope kind `session-checkpoint`) captures everything needed to
restore a session:

- experiment id, seed-bearing definition (persisted separately), player/DPI,
- blinded candidate labels and rep counters,
- completed sequence keys + completed trial ids,
- current round, phase log, active/continuous testing ms,
- full audit trail (restored with strict sequence continuity),
- capture-source metadata provenance, calibration references,
- retest linkage, app/engine/optimizer versions,
- `interruptedTrial`: the pre-trial pending marker naming the trial that was
  in flight when the process died.

## Protocol

1. Before EVERY trial execution the runner writes a checkpoint WITH the
   pending-trial marker.
2. After the trial persists, the marker is cleared in the post-trial
   checkpoint.
3. A crash therefore leaves a checkpoint that names exactly one ambiguous
   trial — never zero, never two.

## Resume semantics

`SessionRunner.resumeFrom(rawCheckpoint, definition, ports, restoredTrials)`:

- fails closed on corrupted/incompatible checkpoints (typed errors),
- restores blinding, counters, audit log (strict seq validation), timing,
- NEVER repeats completed steps (plan specs filtered by completed keys),
- invalidates the interrupted in-progress trial explicitly
  (`audit: trial-invalidated {reasons:"INTERRUPTED_IN_PROGRESS"}`) and lets
  the plan re-run it once as fresh data,
- appends `session-resumed` audit metadata.

## Startup UX

The Setup tab lists incomplete sessions with player, date/time, experiment,
completed trials, round, capture source, last valid state and age; actions:
Resume / Export diagnostic bundle / Discard (discard marks `status:"aborted"`
— raw data is never deleted).

## Tested recovery scenarios

`tests/sessionResumeRecovery.test.ts` covers: crash between trials, crash
mid-trial (invalidation + repeat), corrupted checkpoints, incompatible
definitions, interruption during rest/candidate transitions, UI summary
fields, no-silent-repeat invariant. Browser-level resume-list rendering is
covered by `tests/browser/persistence.spec.ts`.
