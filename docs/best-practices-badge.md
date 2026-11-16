# OpenSSF Best Practices Badge

A maintainer registers code-review at [bestpractices.dev](https://www.bestpractices.dev) and answers the criteria
there, which is the source of truth; this page doesn't copy the answers. It maps the criteria that need a document to
the evidence this repository holds, so registering is answering, not researching.

[//]: # "Maintainers: once registered, name the project's number here and in the badge below, in place of PROJECT_ID."

## The Badge

```html
<a href="https://www.bestpractices.dev/projects/PROJECT_ID"><img alt="OpenSSF Best Practices"
  src="https://www.bestpractices.dev/projects/PROJECT_ID/badge"></a>
```

OpenSSF Scorecard's CII-Best-Practices check scores the badge level: in progress 2, passing 5, silver 7, gold 10
([ADR-0020](decisions/project-template/0020-github-projects-are-scored-by-openssf-scorecard.md)).

## Toward Silver

The silver criteria that need a document point to these:

| Criteria | Where |
| --- | --- |
| `governance`, `roles_responsibilities` | [GOVERNANCE.md](../GOVERNANCE.md) |
| `code_of_conduct` | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
| `documentation_roadmap` | [ROADMAP.md](../ROADMAP.md) |
| `documentation_architecture` | [architecture.md](architecture.md) |
| `documentation_security`, `assurance_case`, `implement_secure_design` | [assurance-case.md](assurance-case.md) |
| Vulnerability response and credit | [SECURITY.md](../SECURITY.md) |
| Coding standards and their enforcement | [CONTRIBUTING.md](../CONTRIBUTING.md), `.editorconfig` |
| Test policy (`test_policy_mandated`) | [CONTRIBUTING.md](../CONTRIBUTING.md), Make a Change, item 3 |

## Needs a Person

- `access_continuity` (MUST): a second owner of the GitHub organization, as
  [GOVERNANCE.md](../GOVERNANCE.md#continuity) says. Silver can't be claimed until there is one.
- `bus_factor` (SHOULD): a bus factor of 2 or more, which the same second owner gives.
- `two_person_review` (gold): a second maintainer.
- `dco` (SHOULD): unmet. The project doesn't ask for `Signed-off-by`
  ([ADR-0023](decisions/project-template/0023-a-project-ships-the-documents-the-best-practices-silver-level-asks-for.md)).

## Also Supported

OpenSSF Scorecard runs on every push to `main` and once a week (`.github/workflows/scorecard.yml`).
