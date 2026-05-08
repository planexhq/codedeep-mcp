export interface User {
  id: string;
  name: string;
  role: string;
}

export type AuthToken = {
  sub: string;
  exp: number;
};
