# architecture

Does this change fit the design it lands in, or is it duct tape: a workaround layered on earlier patches that a
principal engineer would ask to be done properly?

Look for:

- **Duct tape.** Special cases bolted onto general code; conditionals that exist only to route around an earlier patch;
  hard-coded values, magic numbers and string literals that stand in for a missing abstraction or setting; a flag or
  parameter threaded through several layers to change one behavior deep inside.
- **Bypassed abstractions.** Reaching past an existing service, interface, helper or extension point to do the work
  inline; duplicating logic that already exists elsewhere in the codebase instead of reusing or extending it (search for
  it before reporting).
- **Cohesion and coupling.** Logic for one concern scattered across unrelated types, or one type taking on a second
  responsibility; new dependencies that point the wrong way between layers; a change that forces callers to know
  internals.
- **Pattern drift.** A new way of doing something the codebase already does one established way: how it registers
  services, reports errors, validates input, configures options or shapes its public types.
- **Fragile assumptions.** Logic that only works because of ordering, timing, a particular caller or today's data, with
  nothing that enforces the assumption; a regression in behavior that `main` relied on.

Name the existing pattern or abstraction the change should use, by file or type, and say what doing it properly would
look like. Don't report taste: a finding needs a concrete cost, such as a future change that will now be harder, a
bug the shape invites, or two places that will drift apart. Leave line-level correctness, security and style to the
other reviewers.
