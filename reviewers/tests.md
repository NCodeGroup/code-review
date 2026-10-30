# tests

Is the behavior this pull request changes covered by tests that would fail if it broke?

Look for: changed or new behavior with no test that exercises it; tests the change skipped, deleted or weakened, such as a loosened assertion or an expected value edited to match new output; tests that pass whether or not the code works (asserting nothing, asserting the mock, catching everything); missing edge cases the change makes reachable, such as empty, null, boundary and error inputs; and tests that depend on time, order or machine state and will flake.

Point at the behavior that's untested and the test that would cover it. Don't ask for tests of trivial code, and leave the code's own defects to others.
