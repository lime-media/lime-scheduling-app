/**
 * The staff top menu's grouping and active page (lib/navLinks.ts).
 * Run with: npm test
 */
import { eq, section } from './harness'
import { BAR_LINKS, isActivePath, settingsActive, settingsLinks } from '@/lib/navLinks'

section('navLinks: the bar keeps the daily pages')
eq('seven on the bar', BAR_LINKS.map(l => l.label), ['Schedule', 'Planner', 'Map', 'AI Assistant', 'Reservations', 'Conflicts', 'LED Quote'])

section('navLinks: the rest sit under Settings')
eq('sales', settingsLinks('SALES').map(l => l.label), ['Saturation', 'Rate Cards', 'Transport', 'Opp Origins', 'LED Readiness', 'Users', 'Settings'])
eq('operations also get Usage', settingsLinks('OPERATIONS').map(l => l.label), ['Saturation', 'Rate Cards', 'Transport', 'Opp Origins', 'LED Readiness', 'Users', 'Usage', 'Settings'])
eq('no session: no Usage', settingsLinks(undefined).some(l => l.href === '/usage'), false)
eq('every page appears once', new Set([...BAR_LINKS, ...settingsLinks('OPERATIONS')].map(l => l.href)).size, BAR_LINKS.length + settingsLinks('OPERATIONS').length)

section('navLinks: the active page')
eq('Schedule only on /', isActivePath('/planner', '/'), false)
eq('Schedule on /', isActivePath('/', '/'), true)
eq('exact page', isActivePath('/ops/transport', '/ops/transport'), true)
eq('a page under it', isActivePath('/users/abc', '/users'), true)
eq('a longer name is not under it', isActivePath('/usage', '/us'), false)
eq('no pathname yet', isActivePath(null, '/map'), false)

section('navLinks: the Settings button shows active on its pages')
eq('LED Readiness', settingsActive('/ops/led-requests', 'SALES'), true)
eq('Settings itself', settingsActive('/settings', 'SALES'), true)
eq('Usage for operations', settingsActive('/usage', 'OPERATIONS'), true)
eq('Usage is not a sales menu page', settingsActive('/usage', 'SALES'), false)
eq('a bar page', settingsActive('/quote', 'OPERATIONS'), false)
