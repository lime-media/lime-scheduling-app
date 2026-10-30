/**
 * Email bodies. Its own module, with no imports: a template is a pure function
 * of its data, so it can be previewed and tested without nodemailer (which
 * pulls `fs` and cannot be loaded in a browser or a plain test run).
 */

export type OtpEmailFields = { name: string; code: string; ttlMinutes: number }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/**
 * The login-code email.
 *
 * Written for mail clients, not browsers: tables rather than flexbox, every
 * style inline, no external image (a blocked logo would leave a broken box
 * where the brand should be, and a code email is exactly when someone is
 * deciding whether to trust what they are looking at). One solid colour, no
 * gradient — Outlook drops those.
 *
 * The code is the one thing the reader wants, so it is the only large element
 * and is spaced for reading six digits aloud or copying them.
 */
export function otpHtml(data: OtpEmailFields): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f3f4f6;">
  <!-- Preheader: the text the inbox list shows beside the subject. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your code is ${data.code} and expires in ${data.ttlMinutes} minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#2d6b22;padding:20px 28px;">
              <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.02em;">Lime&nbsp;Media</span>
              <span style="color:#ffffff;opacity:0.65;font-size:16px;"> &middot; LED Scheduling</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;">
              <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#111827;">Hi ${esc(data.name)}, here is your one-time login code.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
                <tr>
                  <td align="center" style="padding:22px 12px;">
                    <div style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:0.22em;color:#14532d;line-height:1.2;">${esc(data.code)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 4px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#4b5563;">
                It expires in <strong style="color:#111827;">${data.ttlMinutes} minutes</strong> and works once.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 28px;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:14px;">
                Didn't try to sign in? You can ignore this email — the code is useless without your password, and nobody can sign in with it alone.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export type ExpiringBooking = {
  clientName: string
  markets:    string[]
  trucks:     string[]
  startDate:  string
  endDate:    string
  /** When it lapses, as reps read it (Central). */
  expiresAt:  string
  hoursLeft:  number
  /** The Extend buttons (lib/extendLink.ts); none when it can't be extended from email. */
  extend:     { days: number; label: string; url: string }[]
}
export type ExpiringHoldsEmailFields = { name: string; bookings: ExpiringBooking[]; reservationsUrl: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The expiry reminder's opening line. */
function expiringLead(data: ExpiringHoldsEmailFields): string {
  const n = data.bookings.length
  return n === 1
    ? `A reservation you placed expires in ${plural(data.bookings[0].hoursLeft, 'hour')}.`
    : `${n} reservations you placed expire within the next 24 hours.`
}

/**
 * The expiry reminder: one card per booking (a booking is extended as one),
 * each with Extend buttons. The buttons open a confirm page (app/extend), so a
 * mail scanner that follows links can't extend anything. Mail-client HTML, as
 * otpHtml.
 */
export function expiringHoldsHtml(data: ExpiringHoldsEmailFields): string {
  const cards = data.bookings.map(b => `
          <tr>
            <td style="padding:0 28px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;">
                <tr>
                  <td style="padding:16px 18px;">
                    <div style="font-size:15px;font-weight:700;color:#111827;">${esc(b.clientName)}</div>
                    <div style="font-size:13px;line-height:1.6;color:#4b5563;margin-top:6px;">
                      ${esc(b.markets.join(', ') || 'Unknown market')}<br>
                      ${b.trucks.length > 1 ? 'Trucks' : 'Truck'} ${esc(b.trucks.join(', '))} &middot; ${esc(b.startDate)} &rarr; ${esc(b.endDate)}<br>
                      <strong style="color:#b45309;">Expires ${esc(b.expiresAt)}</strong> (${b.hoursLeft}h)
                    </div>
                    ${b.extend.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr>
                      ${b.extend.map(x => `<td style="padding-right:8px;"><a href="${esc(x.url)}" style="display:inline-block;background:#2d6b22;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 14px;border-radius:8px;">Extend ${x.days} day${x.days > 1 ? 's' : ''} &middot; ${esc(x.label)}</a></td>`).join('')}
                    </tr></table>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>`).join('')
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(expiringLead(data))}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#2d6b22;padding:20px 28px;">
              <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.02em;">Lime&nbsp;Media</span>
              <span style="color:#ffffff;opacity:0.65;font-size:16px;"> &middot; LED Scheduling</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 16px;">
              <p style="margin:0;font-size:15px;line-height:1.5;color:#111827;">${esc(data.name || 'Hi')}, ${esc(expiringLead(data))}</p>
            </td>
          </tr>${cards}
          <tr>
            <td style="padding:4px 28px 28px;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;border-top:1px solid #f3f4f6;padding-top:14px;">
                Extend opens a page to confirm; no sign-in needed. To commit or change it otherwise, open <a href="${esc(data.reservationsUrl)}" style="color:#2d6b22;">Reservations</a>. Anything not committed or extended by its expiry is released automatically and the truck becomes available to everyone else.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** The same reminder as plain text, for mail clients that don't show HTML. */
export function expiringHoldsText(data: ExpiringHoldsEmailFields): string {
  const lines = [`${data.name || 'Hi'},`, '', expiringLead(data), '']
  for (const b of data.bookings) {
    lines.push(
      `${b.clientName}`,
      `  Markets: ${b.markets.join(', ') || 'Unknown'}`,
      `  ${b.trucks.length > 1 ? 'Trucks' : 'Truck'}:   ${b.trucks.join(', ')}`,
      `  Dates:   ${b.startDate} → ${b.endDate}`,
      `  Expires: ${b.expiresAt} (${b.hoursLeft}h)`,
      ...b.extend.map(x => `  Extend ${x.days} day${x.days > 1 ? 's' : ''} (to ${x.label}): ${x.url}`),
      '',
    )
  }
  lines.push(
    `Commit or change them at ${data.reservationsUrl}`,
    '',
    'Anything not committed or extended by its expiry is released automatically and the truck',
    'becomes available to everyone else.',
  )
  return lines.join('\n')
}
