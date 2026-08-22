/**
 * Estimates how much a vault password is actually protecting, so the dialog can tell the user what
 * they are choosing. It never returns a verdict of "not allowed" - there is no such verdict. The
 * point is an informed decision, not a gate.
 */

export type StrengthLabel = 'none' | 'very weak' | 'weak' | 'fair' | 'strong' | 'very strong';

export interface PasswordAssessment {
  entropyBits: number;
  label: StrengthLabel;
  /** Specific, factual observations. Never instructions.  */
  observations: string[];
  /** Rough time to guess, given the Argon2id cost this app uses. */
  crackTime: string;
}

/**
 * Guesses per second an attacker gets against Argon2id at 64 MiB / 3 passes, assuming serious GPU
 * hardware. Memory-hard hashing is what keeps this number low - a plain SHA-256 vault would be
 * millions of times worse. It is an order-of-magnitude figure, and presented as one.
 */
const GUESSES_PER_SECOND = 10_000;

/** The passwords that appear at the top of every breach corpus. Not exhaustive - just the worst. */
const NOTORIOUS = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789', '1234567890',
  'qwerty', 'qwerty123', 'abc123', 'letmein', 'monkey', 'dragon', 'iloveyou', 'admin',
  'welcome', 'login', 'princess', 'sunshine', 'football', 'baseball', 'trustno1', 'master',
  'hunter2', 'passw0rd', '111111', '000000', 'zaq12wsx', 'qazwsx', 'starwars', 'whatever',
  // Famous example passphrases are in wordlists precisely because they are famous.
  'correct horse battery staple', 'correcthorsebatterystaple', 'troubador', 'trustno one',
]);

/**
 * Bits contributed by one word of a passphrase. A phrase's strength comes from how many words were
 * chosen and how large the pool was - not from how many letters they happen to contain. Treating
 * "my vault password" as 97 bits of character entropy is the flattering answer, and the wrong one.
 */
const BITS_PER_WORD = Math.log2(25_000);

/** Undoes the substitutions that make a dictionary word look like it isn't one. */
function deLeet(password: string): string {
  return password
    .toLowerCase()
    .replace(/[4@]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b');
}

/**
 * Recovers the word hiding inside a decorated password: strip the digits and punctuation people add
 * to the ends, then undo letter substitutions in what is left. The order matters - de-leeting first
 * turns a trailing "123" into letters and conceals the very decoration this exists to see through.
 */
function coreWord(password: string): string {
  const stripped = password.toLowerCase().replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
  return deLeet(stripped);
}

const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];

function poolSize(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  // Anything outside ASCII widens the search space considerably.
  if (/[^\x20-\x7e]/.test(password)) pool += 100;
  return Math.max(pool, 1);
}

/** Runs of the same character add far less than their length suggests. */
function effectiveLength(password: string): number {
  let length = 0;
  let previous = '';
  let run = 0;

  for (const character of password) {
    if (character === previous) {
      run += 1;
      length += 1 / (run + 1);
    } else {
      length += 1;
      run = 0;
      previous = character;
    }
  }

  return length;
}

function containsKeyboardRun(password: string): boolean {
  const lower = password.toLowerCase();
  return KEYBOARD_RUNS.some((row) => {
    for (let start = 0; start + 4 <= row.length; start += 1) {
      const run = row.slice(start, start + 4);
      if (lower.includes(run) || lower.includes([...run].reverse().join(''))) {
        return true;
      }
    }
    return false;
  });
}

function describeDuration(seconds: number): string {
  if (seconds < 1) return 'instantly';
  if (seconds < 60) return 'seconds';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `about ${Math.round(seconds / 3600)} hours`;
  if (seconds < 2_592_000) return `about ${Math.round(seconds / 86400)} days`;
  if (seconds < 31_536_000) return `about ${Math.round(seconds / 2_592_000)} months`;

  const years = seconds / 31_536_000;
  if (years < 1000) return `about ${Math.round(years)} years`;
  if (years < 1e6) return `about ${Math.round(years / 1000)} thousand years`;
  if (years < 1e9) return `about ${Math.round(years / 1e6)} million years`;
  return 'longer than the universe has existed';
}

export function assessPassword(password: string): PasswordAssessment {
  if (password.length === 0) {
    return {
      entropyBits: 0,
      label: 'none',
      observations: [
        'Anyone who reaches this vault on the server can open it - an empty password protects nothing.',
      ],
      crackTime: 'instantly',
    };
  }

  const observations: string[] = [];
  const normalised = password.toLowerCase();
  const core = coreWord(password);

  let entropyBits = effectiveLength(password) * Math.log2(poolSize(password));

  // A passphrase is only as strong as the number of words in it. Take whichever model is less
  // flattering: over-estimating here tells someone they are safe when they are not.
  const words = password.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length >= 2 && words.every((word) => /^[a-zA-Z']+$/.test(word))) {
    entropyBits = Math.min(entropyBits, words.length * BITS_PER_WORD);
    observations.push(
      `Counted as ${words.length} words rather than ${password.length} characters - that is how a phrase is actually attacked.`,
    );
  }

  if (NOTORIOUS.has(normalised) || NOTORIOUS.has(core)) {
    // No amount of length maths matters: this is in the first page of every guessing dictionary.
    entropyBits = Math.min(entropyBits, 8);
    observations.push(
      normalised === core
        ? 'This is one of the most commonly used passwords in the world.'
        : 'This is a very common password with a few characters changed or added - wordlists try that first.',
    );
  }
  else if (
    words.length === 1 &&
    /^[a-z]+$/.test(core) &&
    core.length >= 3 &&
    core.length <= 12 &&
    new Set(core).size > 2
  ) {
    // Might be a dictionary word, might be random letters; there is no wordlist here to tell them
    // apart. Assume the worse case, because the cost of guessing wrong runs one way.
    entropyBits = Math.min(entropyBits, 34);
    observations.push(
      'Looks like a single word. Guessers work through wordlists - with digits and symbols appended - before trying anything else.',
    );
  }

  if (containsKeyboardRun(password)) {
    entropyBits = Math.min(entropyBits, entropyBits * 0.7);
    observations.push('Contains a run of keys straight off the keyboard, which guessers try first.');
  }

  if (password.length < 8) {
    observations.push(`Only ${password.length} character${password.length === 1 ? '' : 's'} long.`);
  }

  if (/^[a-z]+$/.test(password)) {
    observations.push('Lowercase letters only.');
  } else if (/^[0-9]+$/.test(password)) {
    observations.push('Digits only.');
  }

  if (new Set(password).size <= 2 && password.length > 2) {
    observations.push('Made of only one or two different characters.');
  }

  const seconds = Math.pow(2, Math.max(entropyBits - 1, 0)) / GUESSES_PER_SECOND;

  let label: StrengthLabel;
  if (entropyBits < 28) label = 'very weak';
  else if (entropyBits < 40) label = 'weak';
  else if (entropyBits < 60) label = 'fair';
  else if (entropyBits < 80) label = 'strong';
  else label = 'very strong';

  return { entropyBits, label, observations, crackTime: describeDuration(seconds) };
}
