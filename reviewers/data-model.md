# data-model

Does this change alter something persisted or exchanged in a way existing data or other parties can't handle?

Look for: migrations that lose data, can't run on existing rows, lock large tables or have no way back; changes to serialized contracts (JSON, protobuf, database columns, cache entries, message schemas) that break reading data written by the previous version or by the other side; and keys, defaults and nullability that differ between the code and the schema.

Data the previous version wrote exists only where something shipped and stored it. When the repository's conventions say nothing is released or stored, as in a pre-release repository, a changed stored or exchanged shape breaks no existing data: report only data this change itself writes and can't read back, or code and schema that disagree.

Leave general correctness and style to others.
