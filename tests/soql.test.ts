/**
 * SOQL string safety. Run with: npm test
 */
import { eq, section } from './harness'
import { soqlString, SAFE_EMAIL } from '@/lib/soql'

section('SOQL: search text cannot break out of the string')
eq("a quote is escaped", soqlString("O'Brien"), "O\\'Brien")
eq('a backslash is escaped before the quote', soqlString("\\' OR Name LIKE '"), "\\\\\\' OR Name LIKE \\'")
eq('plain text is untouched', soqlString('Acme Media'), 'Acme Media')

section('SOQL: only plain emails reach a query')
eq('a normal address is fine', SAFE_EMAIL.test('lmiles@lime-media.com'), true)
eq('no backslash', SAFE_EMAIL.test('x@y\\'), false)
eq('no quote', SAFE_EMAIL.test("x'@y.com"), false)
