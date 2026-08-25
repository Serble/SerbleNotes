#!/usr/bin/env bash
# Fails if any source file contains a non-ASCII character.
#
# The one exception is SerbleNotes.Core/tests/, where emoji, CJK and RTL text are deliberate
# fixtures: they prove that a *user's* non-ASCII note survives encryption, diffing and merging.
# The rule is about text we write, never about data we test with.
#
# The mobile project under src-tauri/gen is skipped for the same reason in reverse: it is written by
# `tauri android init`, not by us, so holding it to our house style would only mean editing generated
# files that get rewritten.
set -uo pipefail

cd "$(dirname "$0")/.."

# The directories are skipped by grep rather than filtered out of its results afterwards. Reading
# them and then throwing the lines away meant scanning every .ts and .json under node_modules on
# every run, and the mutation testing tools add a whole second copy of the project on top of that -
# it went from slow to slower than anyone will wait for.
matches=$(grep -rnP '[^\x00-\x7F]' \
    --include="*.cs" --include="*.rs" --include="*.ts" --include="*.tsx" \
    --include="*.css" --include="*.html" --include="*.md" --include="*.json" \
    --include="*.toml" --include="*.yml" --include="*.yaml" --include="*.py" \
    --include="*.svg" \
    --include="*.sh" --include=".gitignore" \
    --exclude-dir=node_modules --exclude-dir=target --exclude-dir=pkg \
    --exclude-dir=wwwroot --exclude-dir=obj --exclude-dir=bin --exclude-dir=Migrations \
    --exclude-dir=.git --exclude-dir=.claude --exclude-dir=.idea \
    --exclude-dir=.stryker-tmp --exclude-dir=StrykerOutput --exclude-dir=mutants.out \
    --exclude-dir=mutants.out.old --exclude-dir=reports \
    --exclude=package-lock.json --exclude=Cargo.lock \
    . 2>/dev/null \
  | grep -vE '^\./SerbleNotes\.App/src-tauri/gen/' \
  | grep -vE '^\./SerbleNotes\.Core/tests/')

if [ -n "$matches" ]; then
  echo "Non-ASCII characters found in source:"
  echo
  echo "$matches" | sed 's/^/  /'
  echo
  echo "Use ASCII: '-' not an em dash, '...' not an ellipsis, '->' not an arrow."
  echo "Icons must be SVG components, never emoji or unicode glyphs."
  exit 1
fi

echo "check-ascii: clean"
