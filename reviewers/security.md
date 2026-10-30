# security

Can an attacker use this change to read, forge, bypass or exhaust something they shouldn't?

Look for: untrusted input reaching parsing, deserialization, paths, redirects, SQL or logs without validation; token and signature validation that can be skipped, downgraded (algorithm `none`, key confusion) or fooled by issuer, audience, lifetime or nonce handling; secret comparison that isn't constant-time; keys and secrets left in memory, logs, exceptions or error responses; weak randomness for anything security-relevant; missing size and depth limits on attacker-controlled input; authorization checks missing on a new path; and OAuth, OpenID Connect and JOSE behavior that departs from the RFCs in a way an attacker can use.

Name the attack: who controls which input, and what they gain. Leave general correctness and style to others.
