# Releasing

Releases are prepared by Release Please and built by GitHub Actions. Each
release gets a signed Android APK attached to its GitHub release. Maintainers
do not hand-edit versions, tags, release notes or changelog entries.

## One-time repository setup

1. Protect `main` and require `CI / check` before merging pull requests.
2. Let Release Please open pull requests. Either enable *Settings → Actions →
   General → Allow GitHub Actions to create and approve pull requests*, or add
   a fine-grained `RELEASE_PLEASE_TOKEN` secret with contents, pull-request
   and issue write access. A token is preferred: pull requests opened with the
   default token do not trigger CI.
3. Create the Android upload key once, offline, and keep a backup outside
   GitHub. Losing it means users can't install updates over their current app.

   ```sh
   keytool -genkeypair -v -keystore pontspark-upload.keystore \
     -alias pontspark -keyalg RSA -keysize 4096 -validity 10000 \
     -dname "CN=Pontspark, O=Pontmore"
   base64 -w0 pontspark-upload.keystore > pontspark-upload.keystore.b64
   ```

4. Add these Actions secrets:

   | Secret | Value |
   | --- | --- |
   | `BREEZ_API_KEY` | Breez SDK API key compiled into the app |
   | `PONTSPARK_KEYSTORE_BASE64` | contents of `pontspark-upload.keystore.b64` |
   | `PONTSPARK_STORE_PASSWORD` | keystore password |

   The key alias must be `pontspark`. keytool creates PKCS12 keystores,
   whose key password is the store password, so there is no separate secret
   for it. Delete `pontspark-upload.keystore.b64` once the secret is set.

   The release job refuses to build if any of them is missing, and refuses to
   publish a debug-signed APK.

The Breez API key ends up inside the APK, like any `EXPO_PUBLIC_*` value. It
identifies the app to Breez; it is not a wallet secret.

## Preparing a release

Merge changes using Conventional Commit subjects (CI checks them on pull
requests):

- `fix: ...` requests a patch release.
- `feat: ...` requests a minor release.
- `feat!: ...`, `fix!: ...`, or a `BREAKING CHANGE:` footer requests a major
  release. Before 1.0, Release Please treats these as minor bumps.
- `perf:`, `refactor:` and `docs:` appear in the changelog. `test:`, `build:`,
  `ci:` and `chore:` are hidden and, on their own, don't open a release.

Release Please opens or updates a release pull request with the next version
in `package.json` and `package-lock.json` and the generated `CHANGELOG.md`.
Review that pull request as the declaration of the release.

CI builds the release APK on every release pull request, the same way the
release will: production config, signed with the upload key. Merge only when
the `android / build` check passes. Its run's summary page offers the APK as
`pontspark-vX.Y.Z-<sha>.apk`, kept for 14 days, so you can install and try
the release before publishing it.

To build any other branch, run the **Android** workflow from the Actions tab
and give it a branch, tag or commit.

## Publishing

Merging the release pull request creates the `vX.Y.Z` tag and GitHub release.
The `android` job then checks out that exact commit and:

1. installs locked dependencies, type-checks and runs the tests;
2. generates the native project with `EXPO_PUBLIC_APP_ENV=production`
   (app id `xyz.pontmore.pontspark`, mainnet);
3. checks that the upload key opens with the store password and alias
   `pontspark`;
4. builds `assembleRelease` for `arm64-v8a` and `armeabi-v7a`, signed with the
   upload key;
5. verifies the signature and attaches `pontspark-vX.Y.Z.apk` and its
   `.sha256` to the release.

The Android `versionCode` comes from the version (`1.2.3` → `1002003`), so each
release installs over the previous one.

If the build fails, do not move or recreate the tag. For a transient failure
(runner, network, a missing secret), re-run the failed `android` job from the
release's workflow run; it rebuilds the tagged commit and re-uploads with
`--clobber`. If the tagged code itself can't build, land a `fix:` on `main`
and ship it as the next patch release.

## Building a release APK locally

```sh
EXPO_PUBLIC_APP_ENV=production npx expo prebuild --platform android --clean
cd android
ORG_GRADLE_PROJECT_PONTSPARK_UPLOAD_STORE_FILE=/path/to/pontspark-upload.keystore \
ORG_GRADLE_PROJECT_PONTSPARK_UPLOAD_STORE_PASSWORD=... \
  ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
```

Without the `PONTSPARK_UPLOAD_*` properties the release build falls back to
the debug key, which is fine for testing but must never be published.
Re-run `npx expo prebuild --clean` without `EXPO_PUBLIC_APP_ENV` afterwards to
return to the development app id.
