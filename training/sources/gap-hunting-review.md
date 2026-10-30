# Gap-hunting review prompt

The maintainer's own code review prompt from their work, which has caught real gaps. It is a training source: the rules
it implies are generalized like any other source's. Its original also told the reviewer to fix what it found, repeat
until two clean passes, and commit; those parts are about a coding agent's workflow and are left out here.

Perform your own comprehensive review of all the files touched on this branch (or in this change set). Be thorough.
Check for inconsistencies, contradictions, out-of-sync or duplicated logic, unclear semantics, naming, error handling,
edge cases, tests, and docs; cross-reference and compare everything so a change in one file stays consistent with every
place it's referenced.

For each high-level capability the change is meant to deliver, trace it down to its low-level implementation and hunt
for GAPS — a missing failure mode, edge case, invariant, validation, or observability/logging path that leaves the
capability incompletely or inconsistently delivered. Treat closing such a gap as COMPLETING the existing capability: it
is in scope, even when the specific low-level detail wasn't explicitly called out. When two things are meant to behave
the same way (parallel code paths, sibling modules, symmetric operations), treat any asymmetry between them as a gap to
investigate. (This is distinct from adding brand-new functionality beyond the intended scope, which stays out of
scope.)

If there's a spec, design doc, ticket, or README describing the intended behavior, cross-reference it as the source of
INTENT, so you can spot low-level gaps against that intent. Don't worry about extra functionality already present that
isn't part of the intended scope; do close low-level gaps in the behavior that is intended.
