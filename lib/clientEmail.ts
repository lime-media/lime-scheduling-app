/**
 * A client user's email address: whether it can be saved, and how it is shown
 * back during sign-in.
 *
 * Its own module, with no imports, so the browser can use it too. The Users
 * page validates with the same rule the admin API applies, and pulling it
 * from lib/clientOtp.ts would drag nodemailer (and `fs`) into the bundle.
 */

/**
 * Why this address can't be a client user's, or null when it's fine.
 *
 * A client signs in with a code sent to this address and there is no
 * password-only path, so an account saved without one cannot log in at all.
 * Both admin write paths refuse rather than create that account. Deliberately
 * permissive on shape — the check is "somebody could receive mail here", not
 * a full grammar. Pure.
 */
export function clientEmailRefusal(email: unknown): string | null {
  if (typeof email !== 'string' || !email.trim()) {
    return 'An email address is required: client sign-in sends a code to it.'
  }
  const value = email.trim()
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1 || /\s/.test(value)) {
    return `"${value}" is not an email address. Client sign-in sends a code to it.`
  }
  return null
}

/**
 * Where a code was sent, shown on the login screen so the person knows which
 * inbox to check without the address being readable to anyone who guesses a
 * username: "jo***@example.com".
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  const name = email.slice(0, at)
  // A fixed mask, not one per hidden character: the number of stars must not
  // give away how long the address is.
  return `${name.slice(0, 2)}***${email.slice(at)}`
}
