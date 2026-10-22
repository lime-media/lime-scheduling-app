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
