import { hash } from './utils';
import type { User, AuthToken } from './types';

/** Validates the JWT and attaches user to request */
export async function authenticate(req: Request): Promise<User> {
  const token = extractToken(req);
  const payload = verify(token);
  return payload as User;
}

export function authorize(roles: string[]) {
  return (user: User) => roles.includes(user.role);
}

function extractToken(req: Request): string {
  return req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
}
