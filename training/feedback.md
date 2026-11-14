# Corrections to the learned guidance

Every training run follows these when it generalizes rules into `guidance/`. Add a line whenever a learned rule is
wrong, too narrow, too broad, or shouldn't be there; the next `npm run train -- --generalize-only` applies it to every
topic. Edits made directly to `guidance/*.md` are lost at the next training run, so put corrections here. Each training
run rewrites the "Taught with /review teach" section, when there is one, from the closed `review-guidance` issues in
NCodeGroup/code-review; edit the rest by hand.

- Don't name Identity's own packages (`NCode.Identity.*`) or types; describe the concept, such as "the shared JOSE
  abstractions", so the rule reads correctly in any NCodeGroup repository. NCodeGroup's general-purpose packages
  (`NCode.Buffers`, `NCode.Json`, `NCode.Time` and the like) may be named.
- A rule learned from a conventions file for production code doesn't apply to test projects. Say "in production code" in
  its statement, and keep the test conventions' exceptions: a private sealed nested stub that one test file needs, and
  `null!` passed to the code under test in an argument-validation test. A C# rule never applies to a script or a
  workflow.
- Drop the rule that `IOptions<T>.Value` may not be read in a constructor: no current source holds it, and an options
  type fixed at start-up whose validator has no dependencies is read once, at construction.
- A repository's process choices don't generalize: whether its pull requests open as drafts or auto-merge, where its
  changelog puts an entry, and how it changes a decision record. State such a rule as "follow the repository's own rule
  for …", never as one repository's choice. A changelog entry goes under `## [Unreleased]` unless the change also sets
  its own release version, such as a plan's `Release:` line, which writes that version's dated section.
- A rule that asks for a breaking-change label, a compatibility shim, an alias for a renamed setting, a reader for an
  older format, a migration, or an upgrade or rollout note applies only where the repository tracks changes. Say so in
  the rule: in a repository whose conventions say it is pre-release and tracks no changes, renames and format changes
  are allowed outright.
- A parameter the repository's conventions require, such as a `CancellationToken` on every async method, isn't dead
  code; don't teach reviewers to remove it.
