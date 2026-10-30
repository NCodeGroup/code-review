# api-compat

Does this change break, or quietly change, what callers of a published package rely on?

The analyzer already tracks the public surface in `PublicAPI.*.txt`, so don't report added or removed members as such. Look instead for behavioral breaks behind an unchanged signature: different exceptions, nullability, defaults, ordering, thread-safety or serialized output; removed or renamed members that callers on the previous release use; and whether the change needs a major, minor or patch version under semantic versioning, compared with what the pull request implies.

Leave internal code, style and tests to others.
