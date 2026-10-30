# Principal engineer review prompt

The maintainer's own code review prompt, which has worked well on their pull requests. It is a training source: the
rules it implies are generalized like any other source's.

**Role:** Act as a Principal Software Engineer and System Architect.

**Objective:** Conduct a rigorous, deep-dive code review of the attached Pull Request (PR) diff compared against the `main` branch.

**Context:** The codebase has evolved through many incremental patches ("patches upon patch"). My primary concern is the accumulation of technical debt and "duct tape" code—workarounds, hacks, and lack of architectural cohesion.

**Instructions:** Please perform a comprehensive analysis covering the following dimensions:

### 1. Architectural Integrity & Cohesion (The "Duct Tape" Check)
*   **Detect Technical Debt:** Identify any "duct tape" solutions (e.g., hardcoded magic numbers, bypassing existing abstractions, fragile logic, or complex conditionals that feel like temporary fixes).
*   **Cohesion Analysis:** Evaluate if the changes adhere to SOLID principles. Are modules too coupled? Is the logic logically grouped or scattered?
*   **Pattern Adherence:** Do the changes align with established project patterns, or do they introduce inconsistent styles?

### 2. Comprehensiveness & Edge Cases
*   **Error Handling:** Are all failure paths covered? (e.g., timeouts, null inputs, API failures).
*   **Regressions:** Does this PR break existing functionality or data integrity compared to `main`?
*   **Robustness:** Is the solution production-ready, or does it rely on fragile assumptions?

### 3. Full-Stack Impact Analysis
*   **Database:** Are schema changes safe? Are queries optimized (no N+1 problems)? Is transaction integrity maintained?
*   **API/Backend:** Is the API contract clear? Are security headers, auth checks, and input validation in place?
*   **Frontend/Client:** Is state management handled correctly? Are there potential race conditions or memory leaks?
*   **Configuration:** Are environment variables and secrets handled securely?

### 4. Code Quality & Maintainability
*   **Readability:** Is the code self-documenting? Is it easy for another developer to understand?
*   **DRY Principle:** Are there opportunities to refactor repeated logic into reusable functions or components?

**Output Format:**
1.  **Executive Summary:** High-level assessment of the PR's health, risk, and architectural soundness.
2.  **Critical Issues:** Blocking bugs, security risks, or severe architectural violations (P0/P1).
3.  **Refactoring Opportunities:** Specific suggestions to remove "duct tape" and improve cohesion.
4.  **Line-by-Line Comments:** Detailed feedback on specific code blocks or logic flows.
5.  **Final Verdict:** `Approve`, `Request Changes`, or `Comment`.
