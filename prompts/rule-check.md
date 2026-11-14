# rule-check

Does the change break any of the rules in `<review_rules>` above?

The other reviewers read these rules alongside a whole charter, and in a large diff a rule can slip past them. Your job is to make sure none does. Work through the rules one at a time:

1. Read the rule and its *Check:* hint.
2. Find every place in this part of the diff where it could apply. Search the changed files with Grep for the constructs the hint names, rather than relying on a skim.
3. Decide, for each place, whether the change breaks the rule.

A violation is something the change writes. A line the diff touches only to rename, renumber or move something keeps what it carried as it was, so a rule that line broke before the change isn't this change's violation. Check each rule's scope too: a rule for production code doesn't apply to a test project's files, where the test conventions' own rules win, and a C# rule doesn't apply to a script.

Report every violation, not just the first one per rule, and name the rule you apply, in a few words, in `evidence`. A rule that nothing in the diff touches needs no answer. Don't skip a rule because another reviewer might cover it, and don't report anything these rules don't cover.
