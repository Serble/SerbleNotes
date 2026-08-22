#!/usr/bin/env python3
"""Teaches the generated Android project to answer serblenotes:// links.

`tauri android init` writes SerbleNotes.App/src-tauri/gen/android from a template. The deep-link
plugin configures custom URL schemes for desktop only - on Android its config covers verified App
Links (https://your.domain/...), which need a .well-known/assetlinks.json served from that domain and
the app's signing fingerprint in it. A custom scheme needs an intent filter in the manifest instead,
and that is what this adds.

It is idempotent: run it after `android init`, and again after any regeneration. `npm run
android:init` does both in one step. The generated project is meant to be committed, so in the normal
case this runs once and the result is checked in.

    python3 scripts/android-deeplink.py
"""

import re
import sys
from pathlib import Path

SCHEME = "serblenotes"
MANIFEST = Path(__file__).resolve().parent.parent / (
    "SerbleNotes.App/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
)

# autoVerify is deliberately absent: that is for App Links, where Android checks the domain. A custom
# scheme has no domain to check, and claiming verification it cannot do would just be ignored.
FILTER = """
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="{scheme}" />
            </intent-filter>""".format(scheme=SCHEME)


def main() -> int:
    if not MANIFEST.exists():
        print(f"No manifest at {MANIFEST}")
        print("Run `npm run tauri android init` in SerbleNotes.App first.")
        return 1

    text = MANIFEST.read_text(encoding="utf-8")

    if f'android:scheme="{SCHEME}"' in text:
        print(f"{SCHEME}:// is already handled; nothing to do.")
        return 0

    # Attach to the launcher activity, which is the one the OS starts and the one Tauri runs in.
    marker = re.search(
        r'<activity\b[^>]*android:name="\.MainActivity".*?>',
        text,
        flags=re.DOTALL,
    )
    if marker is None:
        print("Could not find MainActivity in the manifest. Has the template changed?")
        return 1

    # After the launcher intent-filter that follows the activity's opening tag, so the two sit
    # together and the file still reads in the order Android documents.
    launcher_end = text.find("</intent-filter>", marker.end())
    if launcher_end == -1:
        print("MainActivity has no intent filter to add alongside. Has the template changed?")
        return 1

    insert_at = launcher_end + len("</intent-filter>")
    patched = text[:insert_at] + FILTER + text[insert_at:]
    MANIFEST.write_text(patched, encoding="utf-8")

    print(f"Added the {SCHEME}:// intent filter to {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
