# Dispatch desk

`desk/api.ts` owns typed fetch/error envelopes, read-only polling, aborted obsolete reads and durable assignment retry commands. `types.ts` defines public DTOs. `forms.tsx` provides validated HTML input and preserves API field errors. `JobDetail.tsx` drives legal lifecycle commands, explainable scores and independently bounded history. `RiderDetail.tsx` exposes configuration and active workload. `App.tsx` composes queues, filters, count cards and attention.

No automatic mutation retries, recommendation polling or client-side reservation logic. Every assignment is revalidated by the server. Demo attribution is explicit; it is not authentication. The first 100 riders resolve names; IDs remain visible beyond that page. Queue/history pagination remains available for all records.
