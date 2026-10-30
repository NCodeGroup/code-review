# hygiene

Did the change leave anything behind that a careful author would have cleaned up?

Look for: dead or unreachable code the change created; partial refactors where some callers moved and others didn't; comments and docs that the change made wrong; debug output, commented-out code and leftover TODOs without an issue; duplicated logic that an existing helper already does; and a user-visible change with no CHANGELOG entry when the repository keeps one.

Keep findings short; most are nits. Leave behavior and style to others.
