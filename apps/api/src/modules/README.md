# Business modules

`domain` contains pure lifecycle, expiry and counter policies plus typed audit payload schemas. `persistence` owns Mongoose schemas, named indexes, initialization and the transaction helper. Phase 2 verifies them against real MongoDB.

Next features add jobs, riders, recommendations, dispatch, history and dashboard services. Controllers will delegate to services; ranking and domain policies stay independently testable. No business endpoints are registered yet. See docs/architecture.md for validation boundaries: document hooks do not replace guarded query updates or cross-document transactions.
