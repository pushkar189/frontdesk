import { Router, Request, Response, NextFunction } from 'express';
import * as bcrypt from 'bcrypt';
import { z } from 'zod';
import { queryOne } from '../db/pool';
import { signToken } from '../middleware/auth';

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);

    const user = await queryOne<{
      id: string;
      name: string;
      email: string;
      password_hash: string;
      role: string;
      is_active: boolean;
    }>('SELECT * FROM users WHERE email = $1', [email]);

    if (!user || !user.is_active) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role as 'AGENT' | 'MANAGER',
      name: user.name,
    });

    // Set httpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24h
    });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

export default router;
