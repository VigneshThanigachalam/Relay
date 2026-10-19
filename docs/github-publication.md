# GitHub publication

Target: [VigneshThanigachalam/Relay](https://github.com/VigneshThanigachalam/Relay), main branch.

The existing remote head at preparation was ebc940626a989ffd0b80bee28a945397f472c0f5. It already contains the initial incremental development history and a deliberate removal of docs/source. Publication retains that history and the removal; it does not force-update or restore those source documents.

The refined application was developed and verified locally through main ae3d518435b8d5e7162fb4093e04c6c0d4c3f58c: stable reads (6f2db45), interface/action feedback (58042eb), documentation (c002123) and checked merge (ae3d518). The earlier seed diagnostic fix is included. The complete original local feature branches and exact commit IDs remain in the downloadable development handoff.

The GitHub connection has repository write access, but the terminal has no credential for an ordinary git push. Publication therefore uses a real GitHub tree/commit on a feature branch, followed by a pull request and merge. These are new publication records, not copies of the original author dates or commit IDs. Original local commits are not falsely represented as having been transferred by Git transport. The authenticated repository account publishes the changes; the commit records Codex Implementation Agent as co-author for implementation attribution.

Before publication, all application and test files are compared with the fully verified local state. The requested tree is built on the existing remote tree and compared with the prepared local tree SHA; main is checked again after merging. Production code has not changed since the 577-test check. Documentation and public-source exclusions receive a separate formatting/diff review. No credentials, real .env, node_modules or generated build output are published.

A later authenticated local git push can transfer the original feature refs without recreating historical commits. Fetch the current remote first and merge its publication changes; never force-push over existing work. The presentation is docs/solution-one-page.pdf, unchanged from the verified one-page handoff.
