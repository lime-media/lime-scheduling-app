import { google } from 'googleapis'

const SHEET_TAB = 'Sheet2'

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (!email || !key) return null
  return new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
}

export interface HoldRequestRow {
  submittedAt:  string
  companyName:  string
  truckNumber:  string
  market:       string
  state:        string
  startDate:    string
  endDate:      string
  notes:        string
  status:       string
}

export async function appendHoldRequestToSheet(row: HoldRequestRow): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID
  const auth = getAuth()
  if (!auth || !spreadsheetId) {
    console.log('[sheets] Not configured — skipping sheet append')
    return
  }

  const sheets = google.sheets({ version: 'v4', auth })

  // Write header row if Sheet2 is empty (A1 check)
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TAB}!A1`,
  })
  if (!check.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['Submitted At', 'Company', 'Truck #', 'Market', 'State', 'Start Date', 'End Date', 'Notes', 'Status']],
      },
    })
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        row.submittedAt,
        row.companyName,
        row.truckNumber,
        row.market,
        row.state,
        row.startDate,
        row.endDate,
        row.notes,
        row.status,
      ]],
    },
  })
}
