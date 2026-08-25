#!/usr/bin/env bash
# The command StrykerJS runs for every mutant.
#
# It exists rather than being a command line in stryker.config.json for one reason: a test run that
# matches no files at all exits 0 from node's test runner. Stryker reads that as "the tests passed",
# so every mutant is reported as having survived - a whole report of nonsense that looks exactly like
# a real result, only worse than useless because it is believable. The check below is the guard.
#
# STRYKER_TESTS narrows the run to the tests that could possibly kill the mutants being made, which
# is what makes this usable: the command runner has no per-test coverage analysis, so whatever this
# says gets rerun for every single mutant. Mutating one module against the whole suite is minutes of
# work per mutant; against that module's own test file it is a fraction of a second.
set -uo pipefail

cd "$(dirname "$0")/.."

tests=${STRYKER_TESTS:-tests/*.test.ts}

# Unquoted on purpose - the glob is the point.
# shellcheck disable=SC2086
if [ "$(ls -1 $tests 2>/dev/null | wc -l)" -eq 0 ]; then
    echo "No test files matched '$tests' - refusing to report every mutant as survived." >&2
    exit 1
fi

# shellcheck disable=SC2086
exec node --experimental-transform-types --import ./tests/support/register.mjs --test $tests
