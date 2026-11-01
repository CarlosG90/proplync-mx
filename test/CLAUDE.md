# test/: unit tests

- Runner is `node --test`. `npm test` runs an explicit file list in `package.json`: **a new test file must be added to that list**, or CI-less runs will silently skip it.
- `_fake-db.mjs` fakes the Supabase client; mock `req`/`res` for handlers. No network, no real keys.
- Test pure logic (merge limits, reply parsing, state machines). UI behaviour is checked in a browser, and what wasn't tested is said plainly in the PR.
- Run a single file: `node --test test/<name>.test.mjs`.
