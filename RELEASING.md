# Releasing

## One-time setup (npm Trusted Publishing)

Publishing uses OIDC, so no npm token is stored in the repository. For each of `@metricmind/tracker`,
`@metricmind/react-native` and `@metricmind/server`, on npmjs.com open the package, then Settings, Trusted Publisher,
GitHub Actions, and enter:

- Organization or user: `metricmind-si`
- Repository: `metricmind`
- Workflow filename: `publish-npm.yml`

## Releasing

1. Bump `version` in the `package.json` of each package that changed (and the Flutter `pubspec.yaml` and Android
   version if those changed). Update `CHANGELOG.md`. Commit to `main` once CI is green.
2. Tag the commit with the plain version, no `v` prefix (Swift Package Manager and JitPack both resolve plain tags):
   `git tag 0.3.0 && git push origin 0.3.0`.
3. Create a GitHub release from that tag. Publishing the release runs `.github/workflows/publish-npm.yml`, which
   publishes each npm package whose version is not on the registry yet, with provenance. The workflow can also be run
   by hand from the Actions tab; it skips versions that already exist.
4. iOS and Android need nothing more: SPM and JitPack build from the tag.

## Flutter

Flutter is published manually, from a maintainer's machine, after the tag exists:

```sh
cd packages/flutter
dart pub publish --dry-run
dart pub publish
```
