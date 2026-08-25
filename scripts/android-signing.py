#!/usr/bin/env python3
"""Teaches the generated Android project to sign a release build.

`tauri android init` writes SerbleNotes.App/src-tauri/gen/android from a template, and that template
signs nothing: a release APK or AAB comes out unsigned, which Google Play refuses and a phone will
not install. This adds the signing config Android expects, reading the key out of
`gen/android/keystore.properties` - a path the template's own .gitignore already excludes, which is
the convention Tauri documents.

The config is deliberately conditional on that file existing. A checkout without it still builds:
`npm run android:build -- --apk --debug` is how the app is put on a phone during development and it
has no business needing the release key. Without the guard, Gradle fails a release build with an
incomplete signing config instead, which says nothing about the file it wanted.

It is idempotent: run it after `android init`, and again after any regeneration. `npm run
android:init` does both this and the deep link filter. The generated project is meant to be
committed, so in the normal case this runs once and the result is checked in.

    python3 scripts/android-signing.py
"""

import sys
from pathlib import Path

GRADLE = Path(__file__).resolve().parent.parent / (
    "SerbleNotes.App/src-tauri/gen/android/app/build.gradle.kts"
)

# rootProject is gen/android, so this sits beside gradle.properties and is the path the template's
# .gitignore already knows about. storeFile is read as written, so an absolute path is the safe thing
# to put in it - CI writes one, because the working directory a Gradle task resolves against is the
# app module rather than the file's own directory.
PROPERTIES = """
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}
"""

# keyPassword falls back to the store password because keytool's default is to use one for both, and
# a key created that way has no separate password to name.
SIGNING_CONFIGS = """    signingConfigs {
        create("release") {
            val storePath = keystoreProperties.getProperty("storeFile")
            if (storePath != null) {
                storeFile = file(storePath)
                storePassword = keystoreProperties.getProperty("password")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                    ?: keystoreProperties.getProperty("password")
            }
        }
    }
"""

APPLY_TO_RELEASE = """            // Unsigned when there is no key on this machine, which is what a development
            // checkout wants. Play refuses an unsigned upload, so CI supplies the file.
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
"""


def main() -> int:
    if not GRADLE.exists():
        print(f"No build file at {GRADLE}")
        print("Run `npm run tauri android init` in SerbleNotes.App first.")
        return 1

    text = GRADLE.read_text(encoding="utf-8")

    if "signingConfigs" in text:
        print("Release signing is already configured; nothing to do.")
        return 0

    # After the tauriProperties block, which is the template's own use of the same import.
    anchor = "\nandroid {\n"
    if anchor not in text:
        print("Could not find the android block. Has the template changed?")
        return 1
    text = text.replace(anchor, PROPERTIES + anchor, 1)

    # Before buildTypes, which is where Android's own documentation puts it and where anyone
    # reading this file will look for it.
    build_types = "    buildTypes {\n"
    if build_types not in text:
        print("Could not find the buildTypes block. Has the template changed?")
        return 1
    text = text.replace(build_types, SIGNING_CONFIGS + build_types, 1)

    release = '        getByName("release") {\n'
    if release not in text:
        print("Could not find the release build type. Has the template changed?")
        return 1
    text = text.replace(release, release + APPLY_TO_RELEASE, 1)

    GRADLE.write_text(text, encoding="utf-8")
    print(f"Added the release signing config to {GRADLE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
