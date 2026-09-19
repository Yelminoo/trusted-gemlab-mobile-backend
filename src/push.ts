import webpush from 'web-push';

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

// Lazily configured — VAPID_* may not be set in every environment (e.g.
// local dev), and we don't want a missing env var to crash the whole
// process at import time. Mirrors getResendClient()'s pattern in otp.ts.
let vapidConfigured = false;
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

// Shared by notifyCustomer and broadcastNotification — both just differ in
// which token rows they start from. Any device Expo reports as
// DeviceNotRegistered (app uninstalled / token revoked) is deleted so it
// isn't retried forever; other errors are logged but left alone (may be
// transient). Never throws — a push failing should never fail the admin
// action that triggered it.
async function sendToExpoTokens(
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

// The Web Push equivalent of sendToExpoTokens, for trusted-gemlab-web's
// browser subscriptions. A 404/410 response means the push service
// considers the subscription permanently gone (browser uninstalled/reset
// its permission, profile deleted, etc.) — same "delete, don't retry
// forever" handling as Expo's DeviceNotRegistered. No-ops entirely (logs
// once) if VAPID keys aren't configured, same fallback spirit as
// sendOtpEmail's RESEND_API_KEY check in otp.ts.
async function sendToWebPushSubscriptions(
  subscriptions: { endpoint: string; p256dh: string; auth: string }[],
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<number> {
  if (subscriptions.length === 0) return 0;
  if (!ensureVapidConfigured()) {
    console.warn('[push] VAPID keys not configured — skipping web push send');
    return 0;
  }

  const payload = JSON.stringify({ title, body, data });
  const staleEndpoints: string[] = [];
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          console.error('[push] web push delivery error for', sub.endpoint, error);
        }
      }
    })
  );

  if (staleEndpoints.length > 0) {
    await prisma.webPushSubscription.deleteMany({ where: { endpoint: { in: staleEndpoints } } });
  }

  return sent;
}

// Targeted at one customer's own device(s)/browser(s) — e.g. "you just
// received 50 points", "your certificate request was approved". Fired
// automatically by the route that caused it. Sends over BOTH channels
// (mobile app via Expo, web app via Web Push) since a customer may have
// either or both registered.
export async function notifyCustomer(
  customerId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const [tokens, subscriptions] = await Promise.all([
    prisma.pushToken.findMany({ where: { customerId } }),
    prisma.webPushSubscription.findMany({ where: { customerId } }),
  ]);
  await Promise.all([sendToExpoTokens(tokens, title, body, data), sendToWebPushSubscriptions(subscriptions, title, body, data)]);
}

// Sends to every registered device/browser across every customer — for
// admin announcements ("new feature is live", "scheduled maintenance")
// rather than something tied to one customer's own action.
export async function broadcastNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<{ sent: number }> {
  const [tokens, subscriptions] = await Promise.all([prisma.pushToken.findMany(), prisma.webPushSubscription.findMany()]);
  const [expoSent, webSent] = await Promise.all([
    sendToExpoTokens(tokens, title, body, data),
    sendToWebPushSubscriptions(subscriptions, title, body, data),
  ]);
  return { sent: expoSent + webSent };
}
