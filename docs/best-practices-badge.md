# OpenSSF Best Practices Badge

code-review is registered at bestpractices.dev as
[project 16752](https://www.bestpractices.dev/projects/16752), where the answers are kept: this page doesn't copy them.
It maps the criteria that need a document to the evidence this repository holds.

## The Badge

```html
<a href="https://www.bestpractices.dev/projects/16752"><img alt="OpenSSF Best Practices"
  src="https://www.bestpractices.dev/projects/16752/badge"></a>
```

OpenSSF Scorecard's CII-Best-Practices check scores the badge level: in progress 2, passing 5, silver 7, gold 10
([ADR-0020](decisions/project-template/0020-github-projects-are-scored-by-openssf-scorecard.md)).

## Where It Stands

Passing since 2026-11-16. Silver can't be claimed while the project has one developer: `access_continuity` needs a
second owner. Its other unmet MUST is `coding_standards_enforced`, since nothing enforces the formatting style yet.
Releases meet `signed_releases` through GitHub's release attestations, which [README.md](../README.md#versions) says
how to verify; release tags aren't signed (`version_tags_signed`, SUGGESTED).

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
| `coding_standards`; `coding_standards_enforced` is unmet | [AGENTS.md](../AGENTS.md), `.editorconfig`, and `tsconfig.json`'s strict checks in CI |
| Test policy (`test_policy_mandated`) | [CONTRIBUTING.md](../CONTRIBUTING.md), Make a Change, item 3 |

## Needs a Person

- `access_continuity` (MUST): a second owner of the GitHub organization, as
  [GOVERNANCE.md](../GOVERNANCE.md#continuity) says. The project has one developer for now, so silver can't be claimed.
- `bus_factor` (SHOULD): a bus factor of 2 or more, which the same second owner gives.
- `two_person_review` (gold): a second maintainer.
- `dco` (SHOULD): unmet. The project doesn't ask for `Signed-off-by`
  ([ADR-0023](decisions/project-template/0023-a-project-ships-the-documents-the-best-practices-silver-level-asks-for.md)).

## Also Supported

OpenSSF Scorecard runs on every push to `main` and once a week (`.github/workflows/scorecard.yml`).
