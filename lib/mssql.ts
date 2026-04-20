import sql from 'mssql'

const config: sql.config = {
  server: process.env.MSSQL_SERVER || 'limemediauat.database.windows.net',
  port: parseInt(process.env.MSSQL_PORT || '1433'),
  database: process.env.MSSQL_DATABASE || 'limemediauat',
  user: process.env.MSSQL_USER || 'limeuatadmin',
  password: process.env.MSSQL_PASSWORD || '',
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000,
    requestTimeout: 120000,
  },
}

let pool: sql.ConnectionPool | null = null

export async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool || !pool.connected) {
    pool = await sql.connect(config)
  }
  return pool
}

export async function query<T = sql.IRecordSet<unknown>>(
  queryString: string,
  params?: Record<string, unknown>
): Promise<T> {
  const connection = await getPool()
  const request = connection.request()
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value)
    }
  }
  const result = await request.query(queryString)
  return result.recordset as T
}

export { sql }
