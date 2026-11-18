<!--
SPDX-FileCopyrightText: 2026 Jasman-Studio
SPDX-License-Identifier: Apache-2.0
-->

# Third-party inventory

The Android project retains these dependency and toolchain declarations:

| Component | Version |
| --- | --- |
| Android Gradle Plugin | 8.7.3 |
| Kotlin Android plugin | 2.0.21 |
| Gradle wrapper | 8.9 |
| Kotlin serialization JSON | 1.7.3 |
| AndroidX Media3 ExoPlayer and OkHttp datasource | 1.5.1 |
| OkHttp | 4.12.0 |
| ZXing Core | 3.5.3 |
| JUnit | 4.13.2 |

The wrapper scripts and JAR retain their upstream Apache-2.0 attribution. See
[the wrapper license](third-party-licenses/Gradle.txt). Dependency artifacts and
packaged notices still require review. Android platform fonts are supplied by
the device. The [upstream Outfit license](third-party-licenses/OFL-Outfit.txt)
is preserved and the font binary is absent. Application artwork is code-drawn
or geometric. Test fixtures use generated media.

The coordinator and web remote use Node built-ins and native ECMAScript
modules. Optional photo decoding uses the operator's FFmpeg installation.
Provider servers, FFmpeg and user library media are external to this project.
