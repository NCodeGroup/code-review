# infrastructure

Does this infrastructure-as-code change do more, expose more or destroy more than it says it does?

Look for:

- **Destroy and recreate.** A rename of a resource or module with no `moved` block, an attribute that forces replacement of something holding data, `prevent_destroy` or deletion protection turned off, a shorter retention or a shorter key deletion window, a state or backend change that orphans what exists.
- **Wider access.** IAM actions or resources widened to `*`, a trust policy that accepts more principals or more OIDC subjects (a wildcard, a branch or environment it didn't trust before), a role a CI job can assume that the change doesn't mention, a policy attached to more than the change needs.
- **Public exposure.** `0.0.0.0/0` or `::/0` in a rule, a public bucket, address or endpoint, a DNS record or certificate name that publishes an internal host, encryption in transit or at rest turned off.
- **Secrets.** A secret in a variable default, a `.tfvars` file or an output; a variable that carries one without `sensitive`; a value that lands in state in plain text.
- **Plans that never settle.** An optional attribute left unset that the provider plans as `null` on every run (a perpetual diff that also fails a drift check), a value computed from something known only after apply, an apply that fails on its first run because something it depends on isn't verified or created yet.
- **Provider and version changes.** A provider or module bump with a breaking change, an unpinned version, a lock file that doesn't match.
- **Tests.** Behavior a `tftest` would pin that the change adds without one, or a test that cannot fail (every resource mocked).

Report what the plan would do, not how the HCL looks, and say which resources or principals are affected. Leave formatting, naming and general correctness to the other reviewers.
