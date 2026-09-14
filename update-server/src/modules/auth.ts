import type { Context } from 'hono'
import type { Config } from '../config'
import type { Store } from '../db'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { eq, lte } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sessions } from '../db/schema'
import { AppError } from '../shared/errors'
import { digest } from './signing'

const cookieName = 'mica_update_session'
const sessionLifetime = 12 * 3600

export class Auth {
  private attempts = 0
  private resetAt = 0

  constructor(private readonly store: Store, private readonly config: Config) {}

  matches(token: string) {
    return timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(this.config.adminToken)))
  }

  bearer(c: Context) {
    const authorization = c.req.header('Authorization')
    return authorization?.startsWith('Bearer ') && this.matches(authorization.slice(7))
  }

  private sessionHash(token: string) {
    return digest(`${this.config.adminToken}:${token}`)
  }

  authenticated(c: Context) {
    if (this.bearer(c))
      return true
    const token = getCookie(c, cookieName)
    if (!token)
      return false
    const session = this.store.db.select().from(sessions).where(eq(sessions.hash, this.sessionHash(token))).get()
    return !!session && session.expiresAt > Date.now()
  }

  requireOrigin(c: Context) {
    if (c.req.header('Origin') !== this.config.publicUrl)
      throw new AppError(403, 'invalid_origin', 'Browser request origin does not match PUBLIC_URL')
  }

  login(c: Context, token: string) {
    this.requireOrigin(c)
    if (Date.now() >= this.resetAt) {
      this.attempts = 0
      this.resetAt = Date.now() + 60000
    }
    if (++this.attempts > 20) {
      c.header('Retry-After', '60')
      throw new AppError(429, 'rate_limited', 'Too many login attempts; try again in one minute')
    }
    if (!this.matches(token))
      throw new AppError(401, 'invalid_token', 'Invalid administrator token')
    const secret = randomBytes(32).toString('base64url')
    this.store.db.transaction(() => {
      this.store.db.delete(sessions).where(lte(sessions.expiresAt, Date.now())).run()
      if (this.store.db.select().from(sessions).all().length >= 100)
        throw new AppError(429, 'session_limit', 'Too many active sessions')
      const previous = getCookie(c, cookieName)
      if (previous)
        this.store.db.delete(sessions).where(eq(sessions.hash, this.sessionHash(previous))).run()
      this.store.db.insert(sessions).values({ hash: this.sessionHash(secret), expiresAt: Date.now() + sessionLifetime * 1000 }).run()
    })
    setCookie(c, cookieName, secret, { httpOnly: true, secure: this.config.publicUrl.startsWith('https:'), sameSite: 'Strict', path: '/', maxAge: sessionLifetime })
  }

  logout(c: Context) {
    const token = getCookie(c, cookieName)
    if (token)
      this.store.db.delete(sessions).where(eq(sessions.hash, this.sessionHash(token))).run()
    deleteCookie(c, cookieName, { path: '/' })
  }
}
