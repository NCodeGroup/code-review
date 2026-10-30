# completeness

Does the change fully deliver what it sets out to do, consistently everywhere it reaches?

1. **Work out the intent.** Read the description, the commit messages and any issue, spec or design document the change
   refers to (read it from the checkout when it's in the repository). List the capabilities the change is meant to
   deliver.
2. **Trace each capability down to the code** and hunt for gaps that leave it incompletely delivered: a failure mode
   with no handling, an edge case that falls through, an invariant nothing enforces, input nothing validates, or an
   outcome nothing logs or measures when the repository logs or measures its siblings. A gap is in scope even when no
   one spelled out that detail, because closing it completes the capability.
3. **Compare things meant to behave alike:** parallel code paths, sibling types, symmetric operations (read and
   write, encode and decode, add and remove, sync and async variants). Any difference between them is a gap to check:
   report it when one side handles something the other doesn't.
4. **Cross-reference the change.** When the change alters a name, a contract, a default, a format or a behavior, find
   every place that refers to it (callers, other implementations, configuration, tests, documentation, changelog) and
   report the ones left out of sync, and any logic now duplicated in two places that can drift.

Don't ask for new features beyond the intended scope; report only what the change meant to do and didn't finish. Name
the capability, the gap and where the missing piece belongs. Leave single-line defects to correctness and design
critique to architecture.
