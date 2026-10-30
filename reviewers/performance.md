# performance

Does this change make a path that runs often measurably slower or hungrier?

Look for: allocations on hot paths (closures, boxing, LINQ, string concatenation, params arrays); `Span<T>`, `Memory<T>`, `ArrayPool` and pooled-buffer misuse, including buffers returned twice, used after return or never returned; sync I/O or blocking on async code; quadratic loops over inputs that grow; and caches without bounds.

Report only what matters for how the code is used: a cold startup path doesn't need micro-optimizing. Leave correctness and style to others.
