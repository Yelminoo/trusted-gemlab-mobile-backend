import { prisma } from './prisma';

// Sends push notifications via Expo's push service directly over HTTPS
// (https://docs.expo.dev/push-notifications/sending-notifications/#http2-api) —
// no `expo-server-sdk` dependency needed for this, same "just call the HTTP
// API" approach already used for Resend in otp.ts. No API key is required
// for Expo's push endpoint itself; only real requirement is that each
// `token` was produced by THIS app's own EAS project on the client.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Expo caps a single request at 100 messages — chunk defensively even
// though one customer having 100+ registered devices is not a realistic
// case today.
const CHUNK_SIZE = 100;

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
};

type ExpoPushTicket = { status: 'ok' | 'error'; message?: string; details?: { error?: string } };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Shared by notifyCustomer and broadcastNotification — both just differ in
// which token rows they start from. Any device Expo reports as
// DeviceNotRegistered (app uninstalled / token revoked) is deleted so it
// isn't retried forever; other errors are logged but left alone (may be
// transient). Never throws — a push failing should never fail the admin
// action that triggered it.
async function sendToTokens(
  tokens: { token: string }[],
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<number> {
  if (tokens.length === 0) return 0;
  const staleTokens: string[] = [];

  for (const batch of chunk(tokens, CHUNK_SIZE)) {
    const messages: ExpoPushMessage[] = batch.map((t) => ({ to: t.token, title, body, data, sound: 'default' }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        console.error('[push] Expo push API returned', res.status, await res.text().catch(() => ''));
        continue;
      }

      const { data: tickets } = (await res.json()) as { data: ExpoPushTicket[] };
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          console.error('[push] delivery error for', batch[i].token, ticket.message);
          if (ticket.details?.error === 'DeviceNotRegistered') {
            staleTokens.push(batch[i].token);
          }
        }
      });
    } catch (error) {
      console.error('[push] failed to send batch:', error);
    }
  }

  if (staleTokens.length > 0) {
    await prisma.pushToken.deleteMany({ where: { token: { in: staleTokens } } });
  }

  return tokens.length - staleTokens.length;
}

// Targeted at one customer's own device(s) — e.g. "you just received 50
// points", "your certificate request was approved". Fired automatically by
// the route that caused it.
export async function notifyCustomer(
  customerId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const tokens = await prisma.pushToken.findMany({ where: { customerId } });
  await sendToTokens(tokens, title, body, data);
}

// Sends to every registered device across every customer — for admin
// announcements ("new feature is live", "scheduled maintenance") rather than
// something tied to one customer's own action.
export async function broadcastNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<{ sent: number }> {
  const tokens = await prisma.pushToken.findMany();
  const sent = await sendToTokens(tokens, title, body, data);
  return { sent };
}
