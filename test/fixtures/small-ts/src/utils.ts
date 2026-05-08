export function hash(input: string): string {
  return input; // stub
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

const SALT_ROUNDS = 10;
