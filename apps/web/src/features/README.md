# Dispatch desk

`desk/api.ts` owns typed fetch/error envelopes, read-only polling and durable assignment retry commands. Successful snapshots remain visible during revalidation. Explicit collection scopes preserve rows across filters; unrelated resources do not share data. Aborted obsolete reads and a write epoch prevent a pre-command GET from overwriting the authoritative mutation response. Errors remain visible until a successful retry.

`types.ts` defines public DTOs. `App.tsx` composes navigation, filters, counts, attention and the focused workspace. `QueueTable.tsx` renders the operational collections. `Sheet.tsx` uses a native modal dialog for background inertness, Escape and focus containment, with explicit opener restoration on React unmount. `feedback.tsx` retains notifications outside individual forms and portals them into the active dialog so the browser top layer cannot hide them.

`forms.tsx` uses validated HTML fields, synchronous duplicate-submit guards, pending labels, persistent errors and unsaved-change feedback. Polling does not remount an edit form. `JobDetail.tsx` owns legal lifecycle commands, exact assignment recovery and explainable recommendations. `JobHistory.tsx` renders paginated attempts and chronological audit events, including raw stored snapshots. `RiderDetail.tsx` exposes configuration and active workload. `Icon.tsx` supplies small local SVG icons; CSS provides restrained motion with a reduced-motion override.

No automatic mutation retries, recommendation polling or client-side reservation logic. Every assignment is revalidated by the server. Demo attribution is explicit; it is not authentication. The first 100 riders resolve names; IDs remain visible beyond that page. Queue/history pagination remains available for all records.
