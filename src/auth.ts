import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// `kind` discriminates admin vs customer tokens so one can never authenticate
// the other's routes (docs/REQUIREMENTS.md NFR-14), even though both are
// signed with the same JWT_SECRET.
export interface AdminSessionPayload {
  kind: 'admin';
  sub: string;
  username: string;
  role: 'ADMIN' | 'SUPERADMIN';
}

export interface CustomerSessionPayload {
  kind: 'customer';
  sub: string;
  email: string;
}

export type SessionPayload = AdminSessionPayload | CustomerSessionPayload;

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(payload: SessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '15m' });
}

export function signRefreshToken(payload: SessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, getSecret()) as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export function verifyAdminToken(token: string): AdminSessionPayload | null {
  const session = verifyToken(token);
  return session && session.kind === 'admin' ? session : null;
}

export function verifyCustomerToken(token: string): CustomerSessionPayload | null {
  const session = verifyToken(token);
  return session && session.kind === 'customer' ? session : null;
}
