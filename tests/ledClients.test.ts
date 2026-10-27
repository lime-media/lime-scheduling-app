/**
 * Suggesting the LED client for a Salesforce account (lib/ledClients.ts).
 *
 * Run with: npm test
 */
import { eq, section } from './harness'
import { clientNameKey, suggestLedClient, type LedClient } from '@/lib/ledClients'

const c = (client: string, client_uid = client): LedClient => ({ client, client_uid })
const LED = [c('Acme Outdoor'), c('Blue River Brewing Co.'), c('North & South Media'), c('Lime Media'), c('Lime Media Maintenance')]
const pick = (name: string, clients = LED) => suggestLedClient(name, clients)?.client ?? null

section('clientNameKey')
eq('drops case, punctuation and suffixes', clientNameKey('Acme Outdoor, Inc.'), 'acme outdoor')
eq('& reads as and', clientNameKey('North & South Media LLC'), 'north and south media')
eq('only noise: empty', clientNameKey('The Group, Inc'), '')

section('suggestLedClient')
eq('same name with a suffix', pick('Acme Outdoor, Inc.'), 'Acme Outdoor')
eq('LED name has the suffix', pick('Blue River Brewing'), 'Blue River Brewing Co.')
eq('ampersand vs and', pick('North and South Media'), 'North & South Media')
eq('an exact match wins over longer names containing it', pick('Lime Media'), 'Lime Media')
eq('the account name inside one LED name', pick('Acme'), 'Acme Outdoor')
eq('inside two LED names: no suggestion', pick('Media'), null)
eq('a word inside a word does not count', pick('Acm'), null)
eq('nothing like it', pick('Zephyr Foods'), null)
eq('two LED clients with the same name: no suggestion', pick('Acme Outdoor', [...LED, c('ACME OUTDOOR', 'dup')]), null)
eq('an empty account name', pick(''), null)
