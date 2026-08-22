import { useMemo } from 'react';
import { assessPassword, type StrengthLabel } from '../services/passwordStrength';

const FILL: Record<StrengthLabel, number> = {
  none: 0,
  'very weak': 15,
  weak: 35,
  fair: 60,
  strong: 82,
  'very strong': 100,
};

/**
 * Tells the user what their password is worth while they type it. It reports and never refuses:
 * a weak password here is a decision, and the only thing that would make it a bad one is making it
 * without knowing.
 */
export function PasswordStrength({ password }: { password: string }) {
  const assessment = useMemo(() => assessPassword(password), [password]);
  const level = assessment.label.replace(' ', '-');

  return (
    <div className="strength" aria-live="polite">
      <div className="strength-bar">
        <div className={`strength-fill ${level}`} style={{ width: `${FILL[assessment.label]}%` }} />
      </div>

      <p className="strength-summary">
        <span className={`strength-label ${level}`}>
          {assessment.label === 'none' ? 'No password' : assessment.label}
        </span>
        {assessment.label !== 'none' && (
          <span className="muted small">
            {' '}- roughly {assessment.crackTime} to guess ({Math.round(assessment.entropyBits)} bits)
          </span>
        )}
      </p>

      {assessment.observations.length > 0 && (
        <ul className="strength-notes">
          {assessment.observations.map((observation) => (
            <li key={observation}>{observation}</li>
          ))}
        </ul>
      )}

      {(assessment.label === 'fair' || assessment.label === 'strong' || assessment.label === 'very strong') && (
        // Say what the number assumes. A guess-time that quietly ignores wordlists is the kind of
        // reassurance that gets someone's vault opened.
        <p className="muted small">
          Assumes it is not in a password wordlist and has not been used elsewhere.
        </p>
      )}
    </div>
  );
}
