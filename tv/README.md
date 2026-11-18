# Ambient Room TV

Standalone Android TV renderer for the Ambient Room v1 coordinator. Android 12
(API 31) or later is required. The application ID is `org.ambientroom.tv`.

On first launch, enter your coordinator's origin and request a pairing code.
Approve that code in the coordinator's host remote within five minutes. Approval
replaces any previously paired TV. Pairing uses a separate claim secret; the
displayed code alone cannot obtain a device token. Device credentials expire
after 30 days and require pairing again. No coordinator address is preconfigured.
HTTPS is the default; local HTTP requires selecting the explicit consent box.

Link library playlists in the host remote. On the TV, choose **Playlists** to
start one, or press OK to start the coordinator's default selection. Merely opening
the application or reading state does not start an idle room. Tracks loop and
resume from the coordinator's saved position. Queue changes preserve the buffered
current item; an empty queue pauses. The TV shows queue order; queue editing,
messages, photo uploads, guest settings and moderation belong to the host remote.

OK toggles play/pause. Media Play, Pause and Next act explicitly. Down/Menu opens
the timer; Left/Right selects 5/15/30/60 minutes or Off, and OK applies. Up/Menu/Back
closes the menu. Back then leaves playback. Up from the scene focuses the controls;
Down returns to the scene. System volume keys pass through. Leaving the Activity,
including Home, sends a resume sample and stop request, then releases audio.
An unavailable coordinator can prevent delivery; local audio still stops.

The timer ducks music to 20%, chimes twice, restores the current base volume and
continues playback. User pause and zero volume are preserved. Messages, timers,
device expiry and guest QR lifetime use server-derived monotonic deadlines while
the app is running. QR codes use the configured origin and a fragment token, and
hide at expiry even during an outage. Network failures retain buffered music and
retry. A device 401 clears pairing and stops audio.

Six code-drawn scenes use system fonts. Scene choice, rain/snow/sun, decoration
and inactivity dimming are local controls; there is no location, calendar, or
weather service. Photos are authenticated, bounded and decoded on CPU. No inherited
art or font binary is included. Device brightness support varies by TV.

**Disconnect** clears local credentials and stops playback. Use the host remote
to revoke the device token and clear room photos: the v1 device role has no device
revocation permission. Clearing Android app storage also removes local pairing.

The project uses AGP 8.7.3, Kotlin 2.0.21, Gradle 8.9, JDK 17 and compile/target SDK
35. Retained library versions are fixed in the app build file. There are no sibling
repositories, signing files, configured signing identities, or deployment tasks.
Release signing is deliberately absent. The included Gradle 8.9 wrapper checks the distribution
checksum. Set `ANDROID_HOME` to your Android SDK and use JDK 17. Provision the
matching Gradle distribution and dependencies before an offline build. From
this directory:

```sh
./gradlew --offline --no-daemon --max-workers=2 --dependency-verification=strict \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease
```

The release task produces an unsigned APK. CI preflight requires reviewed
dependency locks and verification metadata, which are pending for this project.

JVM tests use injected transports and synthetic fixtures under
`app/src/test/resources/fixtures/`. They do not contact a coordinator or media
provider. The frozen API schema and behavior are under `contract/`. The generated
tone and geometric image are test data, not bundled playback or a configured library.
