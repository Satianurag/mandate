/** Local CLI operator session. No session credentials are printed or sent to another host. */
import { readFile } from 'node:fs/promises';
export async function localOperatorClient() {
  const root = new URL('..', import.meta.url).pathname;
  const directory = process.env.MANDATE_OPERATOR_STATE ?? `${root}/state/live/operator`;
  const origin = 'http://127.0.0.1:8410';
  const token = (await readFile(`${directory}/operator-token`, 'utf8')).trim();
  const response = await fetch(`${origin}/api/session`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  });
  const session = await response.json();
  if (!response.ok) throw new Error(session.error ?? 'Operator login failed');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return async function call(path, body, method) {
    if (!path.startsWith('/api/') || path.includes('..')) throw new Error('Only local operator API paths are supported');
    const response = await fetch(`${origin}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { origin, cookie, 'x-mandate-csrf': session.csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(150000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${result.error ?? 'Operator request failed'}`);
    return result;
  };
}
