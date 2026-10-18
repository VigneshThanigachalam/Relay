# Business modules

`domain` contains pure lifecycle, expiry and counter policies plus typed audit payload schemas. `persistence` owns Mongoose schemas, named indexes, initialization and the transaction helper. Phase 2 verifies them against real MongoDB.

`jobs` now provides validated create/list/detail/ready/history endpoints through thin routes and a transaction-owning service. `history/append-event.ts` allocates sequences and appends events inside the caller transaction. Next features add riders, recommendations, dispatch and dashboard services; ranking and domain policies stay independently testable. See docs/architecture.md for validation boundaries: document hooks do not replace guarded query updates or cross-document transactions.
