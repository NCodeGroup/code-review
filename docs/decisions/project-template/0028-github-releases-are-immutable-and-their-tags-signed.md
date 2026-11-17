# 0028. GitHub releases are immutable and their tags signed

- **Status:** Accepted (amends 0016)
- **Date:** 2026-11-16

## Context

The OpenSSF Best Practices silver MUST `signed_releases` asks for signed releases and a documented way to verify them.
Outside a .NET library on GitHub it was a Gap in `docs/best-practices-criteria.md`. The silver SUGGESTED
`version_tags_signed` was Unmet, because `tag-release.yml` made unsigned tags. NCodeGroup/code-review met
`signed_releases` with immutable releases and a documented `gh release verify`.

## Decision

A GitHub repository's releases are immutable, and a public repository's release tags are signed.

- The template's `tools/Set-RepositoryBaseline.ps1` turns on immutable releases, after which GitHub signs an attestation
  of each published release's tag and files. `SECURITY.md`, in Verify a Release, documents `gh release verify <tag>` and
  `gh release verify-asset <tag> <file>`.
- A repository whose default branch has `.github/workflows/release-provenance.yml` keeps mutable releases: that workflow
  attaches a library's packages to its release after it is published, which an immutable release refuses. How a
  library's release works with immutability is decided apart
  ([project-template#393](https://github.com/NCodeGroup/project-template/issues/393)).
- In a public repository, `tag-release.yml` signs each tag with gitsign, Sigstore's keyless signing through the job's
  OIDC token (`id-token: write`), installed by `chainguard-dev/actions/setup-gitsign` pinned to a commit.
  `.template/Publish-Release.ps1 -Sign` tags with `git tag -s`.
- A tag is verified with
  `gitsign verify-tag --certificate-identity https://github.com/OWNER/REPO/.github/workflows/tag-release.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com <tag>`.
- A private repository's tags stay unsigned: Sigstore's public transparency log would publish its name.

## Options considered

- A GPG or SSH key in a repository secret. Rejected: it is a long-lived key per repository, made by hand and kept on the
  site that distributes the software.
- Tags made through GitHub's API. Rejected: the API makes tag objects without a signature.
- gitsign (chosen): there is no key to keep, and the signature names the workflow.

## Consequences

- A new release can't be changed once it is published, so a fix is a new release.
- Scorecard's Signed-Releases check doesn't count an attestation that isn't an asset, so its score doesn't change.
- GitHub shows a gitsign signature as unverified, since its certificate authority isn't GitHub's; `gitsign verify-tag`
  is the check that counts.

## References

- `tools/Set-RepositoryBaseline.ps1` in the template's repository, `.github/workflows/tag-release.yml`,
  `.template/Publish-Release.ps1`, `SECURITY.md`
- [ADR-0016](0016-releases-are-tagged-and-published-when-their-pull-request-merges.md): releases are tagged and published
  when their pull request merges.
