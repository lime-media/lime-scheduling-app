import { getSetting } from '@/lib/appSettings'
import { expiringHoldsHtml, expiringHoldsText, otpHtml, type ExpiringBooking } from '@/lib/emailTemplates'

// Email notifications — wire up SMTP credentials in .env when ready.
// Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//
// Team notification recipients are env-configurable so the distribution list can
// change without a deploy. They were previously hardcoded here, which is how the
// inbound-reservation alert ended up pointed at a single person with the real
// list commented out one line above it — a code change, a PR and a promotion is
// too much friction for "add someone to an email".
//
// Recipients are resolved at SEND time via lib/appSettings: the row edited on
// the Settings page wins, the env var is still honoured as a deploy-level
// override, and a compiled default guarantees a notification is never addressed
// to nothing.
//
//   notify.holds   / HOLD_NOTIFY_EMAIL    a client booked
//   notify.assist  / ASSIST_NOTIFY_EMAIL  a client needs a human

/** One email per booking: every truck it holds, not one email per truck. */
export interface HoldRequestEmailData {
  companyName:  string
  truckNumbers: string[]
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

  const trucks = data.truckNumbers.length === 1 ? `Truck ${data.truckNumbers[0]}` : `${data.truckNumbers.length} trucks`
  const subject = `Hold Request — ${trucks} · ${data.market}`
  const text = [
    `New hold request from ${data.companyName}`,
    ``,
    `${data.truckNumbers.length === 1 ? 'Truck: ' : 'Trucks:'}  ${data.truckNumbers.join(', ')}`,
    `Market:  ${data.market}`,
    `Dates:   ${data.startDate} → ${data.endDate}`,
    data.notes ? `Notes:   ${data.notes}` : null,
    ``,
    `Log in at https://led.lime-media.com to view it on the schedule.`,
  ].filter(Boolean).join('\n')

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      await getSetting('notify.holds'),
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
    to:      await getSetting('notify.assist'),
    subject,
    text,
  })
}

/** One email per cancelled booking: every truck and market in it. */
export interface CancellationEmailData {
  to:           string
  companyName:  string
  truckNumbers: string[]
  markets:      string[]
  startDate:    string
  endDate:      string
  reason:       string
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

  const markets = data.markets.join(', ')
  const trucks = data.truckNumbers.length === 1 ? `Truck ${data.truckNumbers[0]}` : `${data.truckNumbers.length} trucks (${data.truckNumbers.join(', ')})`
  const subject = `Reservation Update — ${markets}`
  const text = [
    `Hi ${data.companyName},`,
    ``,
    `We're reaching out to let you know that your reservation for ${trucks} in ${markets} ` +
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

/** The client's answer to an extension request on a booking: approved (to a date) or denied (released). */
export interface ExtensionDecisionEmailData {
  to:          string
  companyName: string
  markets:     string[]
  startDate:   string
  endDate:     string
  /** Approved: the date the booking is now held until (YYYY-MM-DD). Absent: denied. */
  heldUntil?:  string
}

export async function sendExtensionDecisionEmail(data: ExtensionDecisionEmailData): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[email] SMTP not configured — extension decision (not emailed):', data)
    return
  }

  const nodemailer = (await import('nodemailer')).default
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  })

  const markets = data.markets.join(', ')
  const subject = `Hold Extension ${data.heldUntil ? 'Approved' : 'Declined'} — ${markets}`
  const text = [
    `Hi ${data.companyName},`,
    ``,
    data.heldUntil
      ? `Your request to extend your reservation in ${markets} (${data.startDate} – ${data.endDate}) has been approved. It is now held until ${data.heldUntil}.`
      : `We weren't able to extend your reservation in ${markets} (${data.startDate} – ${data.endDate}), so it has been released.`,
    ``,
    data.heldUntil
      ? `Let us know before then if you'd like to confirm it.`
      : `If you'd still like to run this campaign, please reach out and we'll look at availability with you.`,
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
  // Sent alongside the HTML: what a plain-text client, a screen reader or a
  // phone's notification preview shows.
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
    html:    otpHtml(data),
  })
}

export interface ExpiringHoldsEmailData {
  to:            string
  recipientName: string
  bookings:      ExpiringBooking[]
  reservationsUrl: string
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
      bookings: data.bookings.length,
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

  const n = data.bookings.length
  const subject = n === 1
    ? `Reservation expires tomorrow — ${data.bookings[0].clientName} · Truck${data.bookings[0].trucks.length > 1 ? 's' : ''} ${data.bookings[0].trucks.join(', ')}`
    : `${n} reservations expire within 24 hours`
  const fields = { name: data.recipientName, bookings: data.bookings, reservationsUrl: data.reservationsUrl }

  await transporter.sendMail({
    from:    SMTP_FROM ?? SMTP_USER,
    to:      data.to,
    subject,
    text:    expiringHoldsText(fields),
    html:    expiringHoldsHtml(fields),
  })
}

