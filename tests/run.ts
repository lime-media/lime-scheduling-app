/**
 * Test entry point — `npm test`.
 *
 * Pure-function suites only: no database, no network, no credentials.
 */
import './transport.test'
import './chain.test'
import './markets.test'
import './holdExpiry.test'
import './conflicts.test'
import './planning.test'
import { report } from './harness'

process.exit(report())
