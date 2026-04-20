import nodemailer from 'nodemailer'

export interface ConflictEmailPayload {
  truck_number:      string
  hold_client:       string
  hold_market:       string
  scheduled_program: string
  conflict_start:    string
  conflict_end:      string
  hold_id:           string
}

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

export async function sendConflictEmail(conflict: ConflictEmailPayload): Promise<void> {
  const transporter = createTransporter()
  if (!transporter) {
    console.log('[emailService] SMTP not configured — skipping conflict notification')
    return
  }

  const to = process.env.NOTIFY_EMAIL || process.env.SMTP_USER
  if (!to) return

  await transporter.sendMail({
    from:    process.env.SMTP_USER,
    to,
    subject: `⚠️ Schedule Conflict: Truck ${conflict.truck_number}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#15803d;padding:20px;border-radius:8px 8px 0 0;">
          <h2 style="color:white;margin:0;">⚠️ Scheduling Conflict Detected</h2>
        </div>
        <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px;">
          <p>A conflict has been detected between an existing hold and an LED app schedule block.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr style="background:#fee2e2;">
              <td style="padding:8px;font-weight:bold;border:1px solid #fca5a5;">Truck</td>
              <td style="padding:8px;border:1px solid #fca5a5;">${conflict.truck_number}</td>
            </tr>
            <tr>
              <td style="padding:8px;font-weight:bold;border:1px solid #e5e7eb;">Hold Client</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${conflict.hold_client}</td>
            </tr>
            <tr style="background:#f3f4f6;">
              <td style="padding:8px;font-weight:bold;border:1px solid #e5e7eb;">Hold Market</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${conflict.hold_market}</td>
            </tr>
            <tr>
              <td style="padding:8px;font-weight:bold;border:1px solid #e5e7eb;">LED App Program</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${conflict.scheduled_program}</td>
            </tr>
            <tr style="background:#f3f4f6;">
              <td style="padding:8px;font-weight:bold;border:1px solid #e5e7eb;">Conflict Dates</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${conflict.conflict_start} → ${conflict.conflict_end}</td>
            </tr>
          </table>
          <p style="color:#6b7280;font-size:14px;">
            The hold has <strong>not</strong> been automatically released.
            Please review and resolve this conflict manually.
          </p>
          <a href="${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/conflicts"
             style="background:#15803d;color:white;padding:12px 24px;border-radius:6px;
                    text-decoration:none;display:inline-block;margin-top:8px;">
            View Conflicts
          </a>
        </div>
      </div>
    `,
  })
}
