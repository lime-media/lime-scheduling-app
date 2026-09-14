// Email notifications — wire up SMTP credentials in .env when ready.
// Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//
// Team notification recipients are env-configurable so the distribution list can
// change without a deploy. They were previously hardcoded here, which is how the
// inbound-reservation alert ended up pointed at a single person with the real
// list commented out one line above it — a code change, a PR and a promotion is
// too much friction for "add someone to an email".
//
//   HOLD_NOTIFY_EMAIL    inbound client reservations (portal and MCP)
//   ASSIST_NOTIFY_EMAIL  client assistance / extension requests
//
// Comma-separated for multiple recipients. The defaults below preserve current
// behavior when the vars are unset.

const HOLD_NOTIFY_TO   = process.env.HOLD_NOTIFY_EMAIL   || 'andrew@lime-media.com'
const ASSIST_NOTIFY_TO = process.env.ASSIST_NOTIFY_EMAIL || 'andrew@lime-media.com, bbenekos@lime-media.com'

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
    to:      HOLD_NOTIFY_TO,
    subject,
    text,
  })
}

export interface AssistanceRequestEmailData {
  companyName: string
  market?:     string
  state?:      string
  startDate?:  string
  endDate?:    string
  details:     string
}

export async function sendAssistanceRequestEmail(data: AssistanceRequestEmailData): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[email] SMTP not configured — assistance request received (not emailed):', data)
    return
  }

  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  })

  const subject = `Assistance Request — ${data.companyName}${data.market ? ' · ' + data.market : ''}`
  const text = [
    `${data.companyName} asked the client view assistant to relay a question/need to the Lime Media team.`,
    ``,
    data.market                    ? `Market:  ${data.market}${data.state ? ', ' + data.state : ''}` : null,
    data.startDate && data.endDate ? `Dates:   ${data.startDate} → ${data.endDate}` : null,
    `Details: ${data.details}`,
    ``,
    `Log in at https://led.lime-media.com to review.`,
  ].filter(Boolean).join('\n')

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      ASSIST_NOTIFY_TO,
    subject,
    text,
  })
}

export interface CancellationEmailData {
  to:          string
  companyName: string
  truckNumber: string
  market:      string
  startDate:   string
  endDate:     string
  reason:      string
}

export async function sendCancellationEmail(data: CancellationEmailData): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[email] SMTP not configured — cancellation notice (not emailed):', data)
    return
  }

  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  })

  const subject = `Reservation Update — ${data.market}`
  const text = [
    `Hi ${data.companyName},`,
    ``,
    `We're reaching out to let you know that your reservation for Truck ${data.truckNumber} in ${data.market} ` +
      `(${data.startDate} – ${data.endDate}) has been cancelled.`,
    ``,
    `Reason: ${data.reason}`,
    ``,
    `If you have any questions or would like to explore other options, please don't hesitate to reach out.`,
    ``,
    `— The Lime Media Team`,
  ].join('\n')

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      data.to,
    subject,
    text,
  })
}

export interface OtpEmailData {
  to:         string
  name:       string
  code:       string
  ttlMinutes: number
}

export async function sendOtpEmail(data: OtpEmailData): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // No SMTP configured (e.g. local dev) — log the code so login still works.
    console.log(`[email] SMTP not configured — OTP for ${data.to}: ${data.code}`)
    return
  }

  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  })

  const subject = `Your Lime Media login code: ${data.code}`
  const text = [
    `Hi ${data.name},`,
    ``,
    `Your one-time login code is: ${data.code}`,
    ``,
    `This code expires in ${data.ttlMinutes} minutes and can only be used once.`,
    `If you didn't try to log in, you can ignore this email.`,
  ].join('\n')

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      data.to,
    subject,
    text,
  })
}

export interface ExpiringHoldSummary {
  truckNumber: string
  clientName:  string
  market:      string
  startDate:   string
  endDate:     string
  expiresAt:   string
  hoursLeft:   number
}

export interface ExpiringHoldsEmailData {
  to:         string
  recipientName: string
  holds:      ExpiringHoldSummary[]
}

/**
 * Warn a user that reservations they placed are about to expire.
 *
 * One digest per user rather than one email per hold — a rep with five expiring
 * reservations should get one message they can act on, not five they learn to
 * ignore.
 */
export async function sendExpiringHoldsEmail(data: ExpiringHoldsEmailData): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[email] SMTP not configured — expiry warning not sent:', {
      to: data.to,
      holds: data.holds.length,
    })
    return
  }

  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  })

  const n = data.holds.length
  const subject = n === 1
    ? `Reservation expires tomorrow — Truck ${data.holds[0].truckNumber} · ${data.holds[0].clientName}`
    : `${n} reservations expire within 24 hours`

  const lines = [
    `${data.recipientName || 'Hi'},`,
    ``,
    n === 1
      ? `A reservation you placed expires in ${data.holds[0].hoursLeft} hour${data.holds[0].hoursLeft === 1 ? '' : 's'}.`
      : `${n} reservations you placed expire within the next 24 hours.`,
    ``,
  ]

  for (const h of data.holds) {
    lines.push(
      `Truck ${h.truckNumber} — ${h.clientName}`,
      `  Market:  ${h.market || 'Unknown'}`,
      `  Dates:   ${h.startDate} → ${h.endDate}`,
      `  Expires: ${h.expiresAt} (${h.hoursLeft}h)`,
      ``,
    )
  }

  lines.push(
    `Commit or extend them at https://led.lime-media.com/hold-requests`,
    ``,
    `Anything not committed by its expiry is released automatically and the truck`,
    `becomes available to everyone else.`,
  )

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      data.to,
    subject,
    text:    lines.join('\n'),
  })
}
