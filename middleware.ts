export { default } from 'next-auth/middleware'

export const config = {
  matcher: ['/((?!login|client|api/client|api/auth|_next/static|_next/image|favicon.ico|logo.png).*)'],
}
