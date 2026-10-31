# tests

Is the behavior this pull request changes covered by tests that would fail if it broke?

Look for: changed or new behavior with no test that exercises it; tests the change skipped, deleted or weakened, such as a loosened assertion or an expected value edited to match new output; tests that pass whether or not the code works (asserting nothing, asserting the mock, catching everything); missing edge cases the change makes reachable, such as empty, null, boundary and error inputs; and tests that depend on time, order or machine state and will flake.

Point at the behavior that's untested and the test that would cover it. Don't ask for tests of trivial code, and leave the code's own defects to others.

Before you rate a missing test, look one level down: read the tests of the functions the untested code calls. A missing test is `should-fix` only when the untested path is new behavior, it could plausibly fail in a way a user sees, and no test below it covers that path. It is a `nit` when the code only wraps or composes pieces that have their own tests, when the test would only pin current behavior that nothing shows is wrong, or when it would be a second test for a path another test already runs, such as an empty list that a failure test already passes through. Name the covering test in `evidence`.
