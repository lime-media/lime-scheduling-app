/**
 * The staff top menu: the pages used every day stay on the bar, the rest sit
 * under one Settings menu (components/Navbar.tsx). Pure, so the grouping and
 * the active page are tested (tests/navLinks.test.ts).
 */

export type NavLink = { href: string; label: string }

/** On the bar. Conflicts carries its badge in the Navbar. */
export const BAR_LINKS: readonly NavLink[] = [
  { href: '/',              label: 'Schedule' },
  { href: '/planner',       label: 'Planner' },
  { href: '/map',           label: 'Map' },
  { href: '/ai',            label: 'AI Assistant' },
  { href: '/hold-requests', label: 'Reservations' },
  { href: '/conflicts',     label: 'Conflicts' },
  { href: '/quote',         label: 'LED Quote' },
]

/** Under the Settings menu. Usage is Operations only. */
export function settingsLinks(role: string | undefined): NavLink[] {
  return [
    { href: '/saturation-calculator', label: 'Saturation' },
    { href: '/rate-cards',            label: 'Rate Cards' },
    { href: '/ops/transport',         label: 'Transport' },
    { href: '/ops/opportunities',     label: 'Opp Origins' },
    { href: '/ops/led-requests',      label: 'LED Readiness' },
    { href: '/users',                 label: 'Users' },
    ...(role === 'OPERATIONS' ? [{ href: '/usage', label: 'Usage' }] : []),
    { href: '/settings',              label: 'Notifications' },
  ]
}

/** Whether `pathname` is the link's page, or a page under it ("/" only itself). */
export function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** Whether the current page is one of the Settings menu's, so its button shows active. */
export function settingsActive(pathname: string | null, role: string | undefined): boolean {
  return settingsLinks(role).some(l => isActivePath(pathname, l.href))
}
