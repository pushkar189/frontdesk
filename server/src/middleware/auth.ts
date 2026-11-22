import * as jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../config/constants';

export interface AuthPayload {
  sub: string;    // user id
  email: string;
  role: UserRole;
  name: string;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const JWT_EXPIRES = '24h';

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  try {
    // Check cookie first, then Authorization header
    const cookieToken = req.cookies?.token as string | undefined;
    const headerToken = (req.headers.authorization ?? '').replace('Bearer ', '');
    const token = cookieToken || headerToken;

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(role: UserRole) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({ error: `Requires ${role} role` });
      return;
    }
    next();
  };
}

export function requireManager(req: AuthRequest, res: Response, next: NextFunction): void {
  requireRole('MANAGER')(req, res, next);
}
