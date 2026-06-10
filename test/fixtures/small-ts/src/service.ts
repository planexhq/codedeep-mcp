import * as utils from './utils';

export class AuthService {
  static create(): AuthService {
    return new AuthService();
  }

  login(name: string): string {
    return this.stamp(name);
  }

  stamp(name: string): string {
    return `${name}@${utils.formatDate(new Date())}`;
  }
}

const svc = AuthService.create();
svc.login('admin');
