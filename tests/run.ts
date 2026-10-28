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
import './order.test'
import './attSoft.test'
import './planner.test'
import './brandMarkup.test'
import './sfdcStages.test'
import './quoteOnly.test'
import './soql.test'
import './places.test'
import './brand.test'
import './usageLog.test'
import './transportMetrics.test'
import './sfdcPush.test'
import './primaryContact.test'
import './plannerRows.test'
import './bookings.test'
import './revise.test'
import './tableSort.test'
import './quoteAlternatives.test'
import './holdWriteLock.test'
import './reservationFilters.test'
import './clientChat.test'
import './staffChat.test'
import './claudeReply.test'
import './clientSession.test'
import './emailTemplates.test'
import './mcpEngine.test'
import './ledJobs.test'
import './ledClients.test'
import './ledTruckFollow.test'
import { report, settle } from './harness'

// settle() lets a suite make assertions after a promise resolves; it is a
// no-op for the synchronous ones.
settle().then(() => process.exit(report()))
