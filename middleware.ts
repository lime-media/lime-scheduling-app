export { default } from 'next-auth/middleware'

export const config = {
  matcher: ['/((?!login|client|api/client|api/v1/internal|api/auth|_next/static|_next/image|favicon.ico|logo.png).*)'],
}
