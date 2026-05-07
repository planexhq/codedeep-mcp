// stderr-only logging. console.log would corrupt stdio JSON-RPC.

const DEBUG_ENABLED = process.env.PROBE_DEBUG === '1';

function write(level: 'error' | 'warn' | 'debug', msg: string): void {
  process.stderr.write(`[probe-mcp ${level}] ${msg}\n`);
}

export const log = {
  error: (msg: string) => write('error', msg),
  warn: (msg: string) => write('warn', msg),
  debug: (msg: string) => {
    if (DEBUG_ENABLED) write('debug', msg);
  },
} as const;

export function errMsg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}
