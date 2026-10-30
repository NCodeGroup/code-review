# Corrections to the learned guidance

Every training run follows these when it generalizes rules into `guidance/`. Add a line whenever a learned rule is
wrong, too narrow, too broad, or shouldn't be there; the next `npm run train -- --generalize-only` applies it to every
topic. Edits made directly to `guidance/*.md` are lost at the next training run, so put corrections here.

- Don't name Identity's own packages (`NCode.Identity.*`) or types; describe the concept, such as "the shared JOSE
  abstractions", so the rule reads correctly in any NCodeGroup repository. NCodeGroup's general-purpose packages
  (`NCode.Buffers`, `NCode.Json`, `NCode.Time` and the like) may be named.
