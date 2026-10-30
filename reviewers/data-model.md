# data-model

Does this change alter something persisted or exchanged in a way existing data or other parties can't handle?

Look for: migrations that lose data, can't run on existing rows, lock large tables or have no way back; changes to serialized contracts (JSON, protobuf, database columns, cache entries, message schemas) that break reading data written by the previous version or by the other side; and keys, defaults and nullability that differ between the code and the schema.

Leave general correctness and style to others.
