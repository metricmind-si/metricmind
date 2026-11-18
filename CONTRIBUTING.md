# Contributing

Issues are welcome: bugs, questions, missing platforms, privacy concerns. Please include the SDK, its version,
the platform and what you expected to happen.

Pull requests:

- Every change needs tests that cover it, and all existing tests must pass (`bun run test`, `swift test`,
  `packages/android/test.sh`, `flutter test` in `packages/flutter`; CI runs them all).
- Keep the SDKs dependency-free; they are meant to be small enough to read in one sitting.
- Nothing that identifies a person may be sent without the app or site asking for it: no field values, no
  advertising IDs, no fingerprinting. Anything new that is sent should be listed in the README's privacy section.
- The wire format (`packages/tracker/src/types.ts`) is versioned by MetricMind's closed-source ingest service, so a
  change to it needs a maintainer to change ingest first.
- Write the code yourself. Don't paste code from other analytics SDKs or from projects under licences other than MIT.

This repository is exported from MetricMind's internal monorepo. A maintainer applies an accepted pull request
there, and the next export brings it back here with your authorship kept in the commit.

By contributing you agree that your contribution is licensed under the MIT licence of this repository.
