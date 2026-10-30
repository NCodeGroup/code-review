# intent

Does the change do what its pull request description and linked plan say it does?

Work out the intent first, from the description, the commit messages and any issue it closes; when there's nothing to go on, return no findings. Then compare the stated goal and steps with the diff. Report a stated part that's missing, done differently than described without saying why, or a significant change the description doesn't mention. Be generous with subtasks: a step done in a different but equivalent way, or split across files, counts as done.

Leave code quality to others.
