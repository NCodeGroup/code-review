# conventions

Does the change follow this repository's own review rules, the ones in `<review_rules>` above?

Those rules are the repository's written conventions for the files this pull request touches, with the tool-enforced ones already removed: everything left is something only a reviewer catches. Check the changed code against them and report each place it breaks one. Quote the rule you're applying, in a few words, in `evidence`, and name the file it comes from. A rule that sends you to an ADR or another document means the reasoning is there; read it from the checkout when the finding depends on it.

Report only what the change itself does: not existing code that already broke the rule, and not rules for files this pull request doesn't touch. When a rule and the change's own description disagree, report it and say so. Leave defects the rules don't cover to the other reviewers.
