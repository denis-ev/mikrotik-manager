/**
 * Minimum password policy applied wherever a password is set or changed.
 * Returns an error message if the password is unacceptable, or null if it's OK.
 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password must be a string';
  if (password.length < 10) return 'Password must be at least 10 characters long';
  if (password.length > 200) return 'Password must be at most 200 characters long';
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}
