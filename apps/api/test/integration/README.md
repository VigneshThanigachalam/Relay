# Database integration test gate

Future integration tests must run against real MongoDB in replica-set mode, using an isolated test database. Mocked models do not prove transaction, unique-index or concurrency guarantees. Phase 1 tests exercise HTTP/configuration only. See docs/requirements.md for planned test obligations.
