// Email notifications — wire up SMTP credentials in .env when ready.
// Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

export interface HoldRequestEmailData {
  companyName:  string
  truckNumber:  string
  market:       string
  startDate:    string
  endDate:      string
  notes?:       string
}

export async function sendHoldRequestEmail(data: HoldRequestEmailData): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[email] SMTP not configured — hold request received (not emailed):', data)
    return
  }

  // Lazy-load nodemailer so the module works even when SMTP isn't set up
  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  })

  const subject = `Hold Request — Truck ${data.truckNumber} · ${data.market}`
  const text = [
    `New hold request from ${data.companyName}`,
    ``,
    `Truck:   ${data.truckNumber}`,
    `Market:  ${data.market}`,
    `Dates:   ${data.startDate} → ${data.endDate}`,
    data.notes ? `Notes:   ${data.notes}` : null,
    ``,
    `Log in at https://led.lime-media.com to view it on the schedule.`,
  ].filter(Boolean).join('\n')

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      'andrew@lime-media.com, bbenekos@lime-media.com',
    subject,
    text,
  })
}
