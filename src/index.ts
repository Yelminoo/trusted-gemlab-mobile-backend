import cors from '@fastify/cors';
import Fastify, { FastifyRequest } from 'fastify';

import {
  hashPassword,
  signAccessToken,
  signRefreshToken,
  verifyAdminToken,
  verifyCustomerToken,
  verifyPassword,
} from './auth';
import { formatMemberId, parseMemberId } from './memberId';
import { generateOtp, hashOtp, otpExpiresAt, sendOtpEmail, withinResendCooldown } from './otp';
import { broadcastNotification, notifyCustomer } from './push';
import { prisma } from './prisma';

const app = Fastify({ logger: true });

// Prevents the same logical action (issue/deduct points, review a
// certificate request) from being applied twice — a double-tap firing two
// requests before a button disables, or a client retrying a request whose
// response got lost. See IdempotencyKey's schema comment for the race-safety
// details (the row is reserved via a unique-constraint INSERT before the
// mutation runs). `idempotencyKey` is optional — omitting it just runs the
// handler with no dedup protection, so this never breaks a caller that
// doesn't send one.
type FastifyReplyLike = { code: (n: number) => unknown };
// Body is deliberately `unknown` rather than a generic `T`: each call site's
// handler returns a DIFFERENT shape per branch (success body vs `{error}`),
// and trying to unify those under one type parameter fights TS inference for
// no real benefit — this function's job is transport (cache/replay a status
// + JSON body), not to validate any particular route's response shape. Each
// route's own handler function is where that shape actually gets checked.
async function withIdempotency(
  reply: FastifyReplyLike,
  idempotencyKey: string | string[] | undefined,
  routeKey: string,
  handler: () => Promise<{ statusCode: number; body: unknown }>
): Promise<unknown> {
  const key = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
  if (!key) {
    const result = await handler();
    reply.code(result.statusCode);
    return result.body;
  }

  try {
    await prisma.idempotencyKey.create({
      data: { key, routeKey, statusCode: 0, response: {} },
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
    if (code === 'P2002') {
      const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (existing && existing.routeKey === routeKey && existing.statusCode !== 0) {
        reply.code(existing.statusCode);
        return existing.response;
      }
      reply.code(409);
      return { error: 'This request is already being processed.' };
    }
    throw error;
  }

  const result = await handler();
  await prisma.idempotencyKey.update({
    where: { key },
    data: { statusCode: result.statusCode, response: result.body as object },
  });
  reply.code(result.statusCode);
  return result.body;
}

function getCustomerSession(request: FastifyRequest) {
  const authHeader = request.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  return token ? verifyCustomerToken(token) : null;
}

// Staff session: either a User (staff-only username/password) token, OR a
// Customer token whose account has isAdmin === true. There is no separate
// admin login in the mobile app — an isAdmin-flagged customer gets admin
// access through their SAME email+password session (see Customer.isAdmin's
// comment in schema.prisma). Requires a DB lookup for the customer case
// because the JWT payload itself doesn't carry isAdmin (it can change after
// the token was issued).
type StaffSession = { type: 'admin'; id: number } | { type: 'customer'; id: number };

async function getStaffSession(request: FastifyRequest): Promise<StaffSession | null> {
  const authHeader = request.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  if (!token) return null;

  const adminSession = verifyAdminToken(token);
  if (adminSession) {
    return { type: 'admin', id: Number(adminSession.sub) };
  }

  const customerSession = verifyCustomerToken(token);
  if (customerSession) {
    const customer = await prisma.customer.findUnique({
      where: { id: Number(customerSession.sub) },
      select: { isAdmin: true },
    });
    if (customer?.isAdmin) {
      return { type: 'customer', id: Number(customerSession.sub) };
    }
  }

  return null;
}

// A customer's personal override wins; otherwise the system-wide default
// (seeded to 100, editable via web-internal's /dashboard/points).
async function getEffectiveFreeCertificateCost(customerFreeCertificateCost: number | null): Promise<number> {
  if (customerFreeCertificateCost != null) return customerFreeCertificateCost;
  const setting = await prisma.systemSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return setting.freeCertificateCost;
}

// Finds the most recent OTP record for this customer+purpose (regardless of
// used/expired status) and updates it in place with a fresh code instead of
// inserting a new row every time someone hits "resend" — customer_otps ends
// up with one row per customer+purpose that just gets refreshed, rather than
// accumulating a new row per resend. Returns null (does nothing) if the
// existing record is still within the resend cooldown; the caller should
// treat null the same as success (same generic response either way — this
// mirrors the account-enumeration-safe pattern already used for the request
// routes, just applied to "did we actually resend" too).
async function issueOrRefreshOtp(
  customerId: number,
  purpose: string,
  extra?: { newEmail: string }
): Promise<string | null> {
  const existing = await prisma.customerOtp.findFirst({
    where: { customerId, purpose },
    orderBy: { createdAt: 'desc' },
  });
  if (existing && withinResendCooldown(existing.createdAt)) {
    return null;
  }

  const otp = generateOtp();
  const data = {
    otpHash: hashOtp(otp),
    expiresAt: otpExpiresAt(),
    usedAt: null,
    createdAt: new Date(),
    ...(extra ? { newEmail: extra.newEmail } : {}),
  };

  if (existing) {
    await prisma.customerOtp.update({ where: { id: existing.id }, data });
  } else {
    await prisma.customerOtp.create({ data: { customerId, purpose, ...data } });
  }

  return otp;
}

app.register(cors, { origin: true });

app.get('/health', async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok', db: 'ok', timestamp: new Date().toISOString() };
});

// GET /app-version — public, no auth (must work before login so an
// out-of-date user can be told before they even try to sign in).
// Informational only, admin-edited via web-internal's /dashboard/points.
app.get('/app-version', async () => {
  const setting = await prisma.systemSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return { latestVersion: setting.latestAppVersion };
});

// ---- Admin auth (backend implemented; no mobile screen yet, see docs/REQUIREMENTS.md 2.1) ----

app.post<{ Body: { username?: string; password?: string } }>('/auth/login', async (request, reply) => {
  const { username, password } = request.body ?? {};
  if (!username || !password) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !(await verifyPassword(password, user.password))) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const payload = { kind: 'admin' as const, sub: String(user.id), username: user.username, role: user.role };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user: { id: user.id, username: user.username, role: user.role },
  };
});

app.post<{ Body: { refreshToken?: string } }>('/auth/refresh', async (request, reply) => {
  const { refreshToken } = request.body ?? {};
  const session = refreshToken ? verifyAdminToken(refreshToken) : null;
  if (!session) {
    return reply.code(401).send({ error: 'Invalid or expired refresh token' });
  }
  return { accessToken: signAccessToken(session) };
});

// ---- Customer auth + wallet (mobile — docs/REQUIREMENTS.md 2.4) ----

app.post<{ Body: { email?: string; password?: string } }>('/customer/register', async (request, reply) => {
  const { email, password } = request.body ?? {};
  if (!email || !password || password.length < 8) {
    return reply.code(400).send({ error: 'email and a password of at least 8 characters are required' });
  }

  const existing = await prisma.customer.findUnique({ where: { email } });
  if (existing) {
    return reply.code(409).send({ error: 'Email already registered' });
  }

  const customer = await prisma.customer.create({
    data: {
      email,
      password: await hashPassword(password),
      wallet: { create: {} },
    },
  });

  // Fire off the account-verification OTP — doesn't block/gate the response
  // below, registration succeeds and returns a usable session immediately
  // either way (see Customer.emailVerifiedAt's schema comment).
  const otp = generateOtp();
  await prisma.customerOtp.create({
    data: {
      customerId: customer.id,
      purpose: 'email_verification',
      otpHash: hashOtp(otp),
      expiresAt: otpExpiresAt(),
    },
  });
  sendOtpEmail(customer.email, otp, 'email_verification').catch((err) =>
    app.log.error(err, 'failed to send email_verification OTP email')
  );

  const payload = { kind: 'customer' as const, sub: String(customer.id), email: customer.email };
  return reply.code(201).send({
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    customer: {
      id: customer.id,
      email: customer.email,
      isAdmin: customer.isAdmin,
      isEmailVerified: customer.emailVerifiedAt !== null,
    },
  });
});

app.post<{ Body: { email?: string; password?: string } }>('/customer/login', async (request, reply) => {
  const { email, password } = request.body ?? {};
  if (!email || !password) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const customer = await prisma.customer.findUnique({ where: { email } });
  if (!customer || !(await verifyPassword(password, customer.password))) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const payload = { kind: 'customer' as const, sub: String(customer.id), email: customer.email };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    customer: {
      id: customer.id,
      email: customer.email,
      isAdmin: customer.isAdmin,
      isEmailVerified: customer.emailVerifiedAt !== null,
    },
  };
});

app.get('/customer/wallet', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const wallet = await prisma.wallet.findUnique({
    where: { customerId: Number(session.sub) },
    include: {
      transactions: { orderBy: { createdAt: 'desc' }, take: 50 },
      customer: { select: { freeCertificateCost: true } },
    },
  });
  if (!wallet) {
    return reply.code(404).send({ error: 'Wallet not found' });
  }

  return {
    balance: wallet.balance,
    lifetimeEarned: wallet.lifetimeEarned,
    freeCertificateCost: await getEffectiveFreeCertificateCost(wallet.customer.freeCertificateCost),
    transactions: wallet.transactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      note: t.note,
      createdAt: t.createdAt,
    })),
  };
});

// Registers (or re-registers) this device's Expo push token against the
// signed-in customer. Idempotent by design: `token` is globally unique, so
// re-sending the same token (app relaunch, token refresh callback firing
// again) just no-ops the update rather than creating a duplicate row. If the
// SAME token was previously registered to a DIFFERENT customer (e.g. one
// device shared by two accounts, one logged out and another logged in), the
// upsert re-points it to the new owner — the old owner shouldn't keep
// getting notifications for a device they're no longer signed into.
app.post<{ Body: { token?: string } }>('/customer/push-token', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { token } = request.body ?? {};
  if (!token || typeof token !== 'string') {
    return reply.code(400).send({ error: 'token is required' });
  }

  await prisma.pushToken.upsert({
    where: { token },
    create: { token, customerId: Number(session.sub) },
    update: { customerId: Number(session.sub) },
  });

  return { ok: true };
});

// Called on logout so a signed-out device stops receiving that account's
// notifications immediately, rather than only when Expo eventually reports
// the token as stale.
app.delete<{ Body: { token?: string } }>('/customer/push-token', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { token } = request.body ?? {};
  if (!token || typeof token !== 'string') {
    return reply.code(400).send({ error: 'token is required' });
  }

  // deleteMany (not delete) — if the token row is already gone, or belongs
  // to a different customer for some reason, this is still a safe no-op
  // rather than a 404/500 the client would need to handle specially.
  await prisma.pushToken.deleteMany({ where: { token, customerId: Number(session.sub) } });

  return { ok: true };
});

// ---- Password reset (no auth — proves identity via emailed OTP) ----

const GENERIC_REQUEST_MESSAGE = 'If that email is registered, a code has been sent.';

app.post<{ Body: { email?: string } }>('/customer/password-reset/request', async (request, reply) => {
  const { email } = request.body ?? {};
  if (!email) {
    return reply.code(400).send({ error: 'email is required' });
  }

  const customer = await prisma.customer.findUnique({ where: { email } });
  // Always return the same generic response whether or not the email exists —
  // otherwise this endpoint becomes an account-enumeration oracle.
  if (customer) {
    const otp = await issueOrRefreshOtp(customer.id, 'password_reset');
    if (otp) {
      sendOtpEmail(customer.email, otp, 'password_reset').catch((err) =>
        app.log.error(err, 'failed to send password_reset OTP email')
      );
    }
  }

  return { message: GENERIC_REQUEST_MESSAGE };
});

app.post<{ Body: { email?: string; otp?: string; newPassword?: string } }>(
  '/customer/password-reset/confirm',
  async (request, reply) => {
    const { email, otp, newPassword } = request.body ?? {};
    if (!email || !otp || !newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'email, otp, and a newPassword of at least 8 characters are required' });
    }

    const customer = await prisma.customer.findUnique({ where: { email } });
    const record = customer
      ? await prisma.customerOtp.findFirst({
          where: {
            customerId: customer.id,
            purpose: 'password_reset',
            usedAt: null,
            expiresAt: { gt: new Date() },
            otpHash: hashOtp(otp),
          },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    if (!customer || !record) {
      return reply.code(400).send({ error: 'Invalid or expired code' });
    }

    await prisma.$transaction([
      prisma.customer.update({ where: { id: customer.id }, data: { password: await hashPassword(newPassword) } }),
      prisma.customerOtp.updateMany({
        where: { customerId: customer.id, purpose: 'password_reset', usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: 'Password updated' };
  }
);

// ---- Email change (authenticated — OTP sent to the NEW address to prove ownership) ----

app.post<{ Body: { newEmail?: string } }>('/customer/email-change/request', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const { newEmail } = request.body ?? {};
  if (!newEmail || !newEmail.includes('@')) {
    return reply.code(400).send({ error: 'A valid newEmail is required' });
  }

  const taken = await prisma.customer.findUnique({ where: { email: newEmail } });
  if (taken) {
    return reply.code(409).send({ error: 'Email already in use' });
  }

  const customerId = Number(session.sub);
  const otp = await issueOrRefreshOtp(customerId, 'email_change', { newEmail });
  if (otp) {
    sendOtpEmail(newEmail, otp, 'email_change').catch((err) =>
      app.log.error(err, 'failed to send email_change OTP email')
    );
  }

  return { message: `A code has been sent to ${newEmail}.` };
});

app.post<{ Body: { otp?: string } }>('/customer/email-change/confirm', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const { otp } = request.body ?? {};
  if (!otp) {
    return reply.code(400).send({ error: 'otp is required' });
  }

  const customerId = Number(session.sub);
  const record = await prisma.customerOtp.findFirst({
    where: {
      customerId,
      purpose: 'email_change',
      usedAt: null,
      expiresAt: { gt: new Date() },
      otpHash: hashOtp(otp),
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!record || !record.newEmail) {
    return reply.code(400).send({ error: 'Invalid or expired code' });
  }

  try {
    const customer = await prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id: customerId },
        // Confirming this OTP already proves ownership of the new address,
        // same proof an /verify-email/confirm would give — so this counts
        // as verified too, no need to make them verify it twice.
        data: { email: record.newEmail!, emailVerifiedAt: new Date() },
      });
      await tx.customerOtp.updateMany({
        where: { customerId, purpose: 'email_change', usedAt: null },
        data: { usedAt: new Date() },
      });
      return updated;
    });
    return {
      customer: { id: customer.id, email: customer.email, isEmailVerified: customer.emailVerifiedAt !== null },
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
    if (code === 'P2002') {
      return reply.code(409).send({ error: 'Email already in use' });
    }
    throw error;
  }
});

// ---- Account email verification (authenticated — OTP sent at registration) ----
//
// Registration already sent one of these (see /customer/register). This is
// just the resend + confirm pair, same shape as password-reset/email-change
// above. Doesn't gate login/access — see Customer.emailVerifiedAt's comment.

app.post('/customer/verify-email/request', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const customerId = Number(session.sub);

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return reply.code(404).send({ error: 'Customer not found' });
  }
  if (customer.emailVerifiedAt) {
    return { message: 'Email already verified.' };
  }

  const otp = await issueOrRefreshOtp(customerId, 'email_verification');
  if (otp) {
    sendOtpEmail(customer.email, otp, 'email_verification').catch((err) =>
      app.log.error(err, 'failed to send email_verification OTP email')
    );
  }

  return { message: `A code has been sent to ${customer.email}.` };
});

app.post<{ Body: { otp?: string } }>('/customer/verify-email/confirm', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const { otp } = request.body ?? {};
  if (!otp) {
    return reply.code(400).send({ error: 'otp is required' });
  }

  const customerId = Number(session.sub);
  const record = await prisma.customerOtp.findFirst({
    where: {
      customerId,
      purpose: 'email_verification',
      usedAt: null,
      expiresAt: { gt: new Date() },
      otpHash: hashOtp(otp),
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) {
    return reply.code(400).send({ error: 'Invalid or expired code' });
  }

  const customer = await prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id: customerId },
      data: { emailVerifiedAt: new Date() },
    });
    await tx.customerOtp.updateMany({
      where: { customerId, purpose: 'email_verification', usedAt: null },
      data: { usedAt: new Date() },
    });
    return updated;
  });

  return { customer: { id: customer.id, email: customer.email, isEmailVerified: true } };
});

// ---- Free certificate requests (customer side) ----
//
// Points are NOT deducted on submission — only when an admin approves (see
// the admin section below). A customer can only have one pending request at
// a time (guard against spamming the admin queue).

app.get('/customer/certificate-requests', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const requests = await prisma.certificateRequest.findMany({
    where: { customerId: Number(session.sub) },
    orderBy: { createdAt: 'desc' },
  });
  return { requests };
});

app.post<{ Body: { customerNote?: string } }>('/customer/certificate-requests', async (request, reply) => {
  const session = getCustomerSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const customerId = Number(session.sub);

  const [customer, existingPending] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { freeCertificateCost: true, wallet: { select: { balance: true } } },
    }),
    prisma.certificateRequest.findFirst({ where: { customerId, status: 'pending' } }),
  ]);
  if (!customer?.wallet) {
    return reply.code(404).send({ error: 'Wallet not found' });
  }
  if (existingPending) {
    return reply.code(409).send({ error: 'You already have a pending certificate request' });
  }

  const cost = await getEffectiveFreeCertificateCost(customer.freeCertificateCost);
  if (customer.wallet.balance < cost) {
    return reply.code(400).send({ error: `You need at least ${cost} points to request a free certificate` });
  }

  const { customerNote } = request.body ?? {};
  const created = await prisma.certificateRequest.create({
    data: { customerId, pointsCost: cost, customerNote: customerNote?.trim() || null },
  });
  return reply.code(201).send({ request: created });
});

// ---- Admin: member lookup, credit adjustment, member history, request review ----
//
// Mirrors web-internal's /api/customers, /api/customers/:id/points, and
// /api/certificate-requests — same tables, same atomic-transaction logic,
// independently implemented here per the two-backends-one-DB architecture
// (see TECHSTACK.md). This is what the mobile app's Admin tab calls.

app.get<{ Querystring: { search?: string; memberId?: string } }>('/admin/members', async (request, reply) => {
  const session = await getStaffSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const { search, memberId } = request.query;
  const scannedId = memberId ? parseMemberId(memberId) : search ? parseMemberId(search) : null;

  const customers = await prisma.customer.findMany({
    where: scannedId
      ? { id: scannedId }
      : search
        ? { email: { contains: search, mode: 'insensitive' } }
        : {},
    select: {
      id: true,
      email: true,
      createdAt: true,
      isAdmin: true,
      wallet: { select: { balance: true, lifetimeEarned: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return { members: customers.map((c) => ({ ...c, memberId: formatMemberId(c.id) })) };
});

app.get<{ Params: { id: string } }>('/admin/members/:id', async (request, reply) => {
  const session = await getStaffSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const customerId = parseInt(request.params.id, 10);
  if (isNaN(customerId)) {
    return reply.code(400).send({ error: 'Invalid member id' });
  }

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      email: true,
      freeCertificateCost: true,
      isAdmin: true,
      wallet: {
        select: {
          balance: true,
          lifetimeEarned: true,
          transactions: { orderBy: { createdAt: 'desc' }, take: 100 },
        },
      },
    },
  });
  if (!customer) {
    return reply.code(404).send({ error: 'Member not found' });
  }

  return {
    ...customer,
    memberId: formatMemberId(customer.id),
    effectiveFreeCertificateCost: await getEffectiveFreeCertificateCost(customer.freeCertificateCost),
  };
});

// Grants/revokes admin access through the SAME customer session — see
// Customer.isAdmin's schema comment. Any staff session can flip this for any
// member (no separate role hierarchy in this app), with one guard: you can't
// revoke your OWN admin access this way, so there's no way to accidentally
// lock every admin out at once.
app.patch<{ Params: { id: string }; Body: { isAdmin?: boolean } }>(
  '/admin/members/:id/admin-status',
  async (request, reply) => {
    const session = await getStaffSession(request);
    if (!session) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const customerId = parseInt(request.params.id, 10);
    if (isNaN(customerId)) {
      return reply.code(400).send({ error: 'Invalid member id' });
    }
    const { isAdmin } = request.body ?? {};
    if (typeof isAdmin !== 'boolean') {
      return reply.code(400).send({ error: 'isAdmin must be a boolean' });
    }
    if (session.type === 'customer' && session.id === customerId && !isAdmin) {
      return reply.code(400).send({ error: "You can't remove your own admin access." });
    }

    try {
      const customer = await prisma.customer.update({
        where: { id: customerId },
        data: { isAdmin },
        select: { id: true, email: true, isAdmin: true },
      });
      return { customer: { ...customer, memberId: formatMemberId(customer.id) } };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
      if (code === 'P2025') {
        return reply.code(404).send({ error: 'Member not found' });
      }
      throw error;
    }
  }
);

app.post<{ Params: { id: string }; Body: { type?: string; amount?: number; note?: string } }>(
  '/admin/members/:id/points',
  async (request, reply) => {
    const session = await getStaffSession(request);
    if (!session) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const customerId = parseInt(request.params.id, 10);
    if (isNaN(customerId)) {
      return reply.code(400).send({ error: 'Invalid member id' });
    }

    const { type, amount, note } = request.body ?? {};
    if (type !== 'credit' && type !== 'debit') {
      return reply.code(400).send({ error: 'type must be "credit" or "debit"' });
    }
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive integer' });
    }
    if (typeof note !== 'string' || !note.trim()) {
      return reply.code(400).send({ error: 'note is required' });
    }

    return withIdempotency(reply, request.headers['idempotency-key'], 'admin_points', async () => {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const wallet = await tx.wallet.findUnique({ where: { customerId } });
          if (!wallet) throw new Error('WALLET_NOT_FOUND');

          const delta = type === 'credit' ? amount : -amount;
          const newBalance = wallet.balance + delta;
          if (newBalance < 0) throw new Error('INSUFFICIENT_BALANCE');

          const updatedWallet = await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              balance: newBalance,
              lifetimeEarned: type === 'credit' ? wallet.lifetimeEarned + amount : wallet.lifetimeEarned,
            },
          });
          const transaction = await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type,
              amount,
              balanceAfter: newBalance,
              note: note.trim(),
              initiatedBy: session.type === 'admin' ? session.id : null,
              initiatedByCustomerId: session.type === 'customer' ? session.id : null,
            },
          });
          return { wallet: updatedWallet, transaction };
        });

        // Fire-and-forget — notifyCustomer never throws, so this can't turn
        // a successful points update into a failed response.
        void notifyCustomer(
          customerId,
          type === 'credit' ? 'Points received' : 'Points deducted',
          type === 'credit'
            ? `You received ${amount} points. New balance: ${result.wallet.balance}.`
            : `${amount} points were deducted. New balance: ${result.wallet.balance}.`
        );

        return {
          statusCode: 200,
          body: {
            wallet: { balance: result.wallet.balance, lifetimeEarned: result.wallet.lifetimeEarned },
            transaction: result.transaction,
          },
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'WALLET_NOT_FOUND') {
          return { statusCode: 404, body: { error: 'Member or wallet not found' } };
        }
        if (error instanceof Error && error.message === 'INSUFFICIENT_BALANCE') {
          return { statusCode: 400, body: { error: 'Insufficient balance for this deduction' } };
        }
        throw error;
      }
    });
  }
);

app.get<{ Querystring: { status?: string } }>('/admin/certificate-requests', async (request, reply) => {
  const session = await getStaffSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { status } = request.query;
  const requests = await prisma.certificateRequest.findMany({
    where: status ? { status } : {},
    include: { customer: { select: { id: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return {
    requests: requests.map((r) => ({ ...r, customer: { ...r.customer, memberId: formatMemberId(r.customer.id) } })),
  };
});

app.patch<{ Params: { id: string }; Body: { decision?: string; adminNote?: string } }>(
  '/admin/certificate-requests/:id',
  async (request, reply) => {
    const session = await getStaffSession(request);
    if (!session) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const requestId = parseInt(request.params.id, 10);
    if (isNaN(requestId)) {
      return reply.code(400).send({ error: 'Invalid request id' });
    }
    const { decision, adminNote } = request.body ?? {};
    if (decision !== 'approved' && decision !== 'rejected') {
      return reply.code(400).send({ error: 'decision must be "approved" or "rejected"' });
    }

    return withIdempotency(reply, request.headers['idempotency-key'], 'admin_review_request', async () => {
      try {
        const updated = await prisma.$transaction(async (tx) => {
          // Atomically claim the request: this UPDATE's WHERE only matches
          // a still-pending row, and Postgres serializes concurrent UPDATEs
          // against the same row, so at most one of two racing requests can
          // ever see count:1 here — closes a real double-approval race that
          // the previous read-then-write (SELECT, then a separate UPDATE)
          // could not: both could read status:'pending' before either
          // committed, and both would then deduct points.
          const claim = await tx.certificateRequest.updateMany({
            where: { id: requestId, status: 'pending' },
            data: {
              status: decision,
              adminNote: adminNote ?? null,
              reviewedBy: session.type === 'admin' ? session.id : null,
              reviewedByCustomerId: session.type === 'customer' ? session.id : null,
              reviewedAt: new Date(),
            },
          });
          if (claim.count === 0) {
            const existing = await tx.certificateRequest.findUnique({ where: { id: requestId } });
            if (!existing) throw new Error('REQUEST_NOT_FOUND');
            throw new Error('ALREADY_REVIEWED');
          }

          const certRequest = await tx.certificateRequest.findUniqueOrThrow({ where: { id: requestId } });

          if (decision === 'approved') {
            const wallet = await tx.wallet.findUnique({ where: { customerId: certRequest.customerId } });
            if (!wallet) throw new Error('WALLET_NOT_FOUND');
            const newBalance = wallet.balance - certRequest.pointsCost;
            if (newBalance < 0) throw new Error('INSUFFICIENT_BALANCE');

            await tx.wallet.update({ where: { id: wallet.id }, data: { balance: newBalance } });
            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: 'debit',
                amount: certRequest.pointsCost,
                balanceAfter: newBalance,
                note: 'Free certificate request approved',
                certificateRequestId: certRequest.id,
                initiatedBy: session.type === 'admin' ? session.id : null,
                initiatedByCustomerId: session.type === 'customer' ? session.id : null,
              },
            });
          }

          // Throwing anywhere above rolls back the whole transaction,
          // including the claim update — an insufficient-balance failure
          // after claiming leaves the request back at 'pending' for a
          // future retry, not stuck half-approved.
          return certRequest;
        });

        void notifyCustomer(
          updated.customerId,
          decision === 'approved' ? 'Certificate request approved' : 'Certificate request rejected',
          decision === 'approved'
            ? 'Your free certificate request was approved.'
            : 'Your free certificate request was rejected.'
        );

        return { statusCode: 200, body: { request: updated } };
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_NOT_FOUND') {
          return { statusCode: 404, body: { error: 'Request not found' } };
        }
        if (error instanceof Error && error.message === 'ALREADY_REVIEWED') {
          return { statusCode: 400, body: { error: 'Request was already reviewed' } };
        }
        if (error instanceof Error && error.message === 'WALLET_NOT_FOUND') {
          return { statusCode: 404, body: { error: 'Member wallet not found' } };
        }
        if (error instanceof Error && error.message === 'INSUFFICIENT_BALANCE') {
          return { statusCode: 400, body: { error: 'Member no longer has enough balance for this request' } };
        }
        throw error;
      }
    });
  }
);

// GET /admin/activity-log — a combined, chronological feed of this admin's
// own actions (points issued/deducted + certificate requests reviewed).
// Read-only — nothing here can be edited or deleted, matches the append-only
// ledger philosophy already used for wallet_transactions.
app.get('/admin/activity-log', async (request, reply) => {
  const session = await getStaffSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const transactionWhere = session.type === 'admin' ? { initiatedBy: session.id } : { initiatedByCustomerId: session.id };
  const reviewedWhere =
    session.type === 'admin' ? { reviewedBy: session.id } : { reviewedByCustomerId: session.id };

  const [transactions, reviewedRequests] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: transactionWhere,
      include: { wallet: { include: { customer: { select: { id: true, email: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.certificateRequest.findMany({
      where: { ...reviewedWhere, status: { not: 'pending' } },
      include: { customer: { select: { id: true, email: true } } },
      orderBy: { reviewedAt: 'desc' },
      take: 100,
    }),
  ]);

  const entries = [
    ...transactions.map((t) => ({
      id: `txn-${t.id}`,
      kind: 'points' as const,
      type: t.type,
      amount: t.amount,
      note: t.note,
      member: { id: t.wallet.customer.id, email: t.wallet.customer.email, memberId: formatMemberId(t.wallet.customer.id) },
      createdAt: t.createdAt,
    })),
    ...reviewedRequests.map((r) => ({
      id: `req-${r.id}`,
      kind: 'certificate_request' as const,
      status: r.status,
      pointsCost: r.pointsCost,
      adminNote: r.adminNote,
      member: { id: r.customer.id, email: r.customer.email, memberId: formatMemberId(r.customer.id) },
      createdAt: r.reviewedAt ?? r.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return { entries };
});

// Sends one push notification to every device that's ever registered a
// token — for announcing something to the whole customer base (a new
// feature, scheduled maintenance) rather than something tied to one
// customer's own action. Any staff session can trigger this; there's no
// idempotency protection here on purpose — a double-tap sending the same
// announcement twice is a mild annoyance, not a points/data bug, and admins
// should be free to re-send the same announcement deliberately too.
app.post<{ Body: { title?: string; body?: string } }>('/admin/notifications/broadcast', async (request, reply) => {
  const session = await getStaffSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { title, body } = request.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    return reply.code(400).send({ error: 'title is required' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return reply.code(400).send({ error: 'body is required' });
  }

  const { sent } = await broadcastNotification(title.trim(), body.trim());
  return { sent };
});

// ---- Certificates — authenticated, owner-scoped only (search, scan-lookup, "My Certificates") ----
//
// There is deliberately no public/unauthenticated certificate lookup right
// now. A certNo that exists but belongs to a different customer 404s exactly
// the same as one that doesn't exist at all — that's not a bug, it's the
// point: existence of another customer's certificate must never be
// confirmable by someone who isn't its owner. If a public verification
// feature is wanted later (e.g. for a buyer checking a stone that isn't
// theirs), that should be a new, separate, explicitly-public endpoint —
// not a relaxation of this one.
app.get<{ Querystring: { certNo?: string; search?: string; limit?: string; offset?: string } }>(
  '/customer/certificates',
  async (request, reply) => {
    const session = getCustomerSession(request);
    if (!session) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const customerId = Number(session.sub);
    const { certNo, search } = request.query;

    if (certNo) {
      const certificate = await prisma.certificate.findFirst({
        where: { certificateNo: certNo, customerId },
        omit: { customerId: true },
      });
      if (!certificate) {
        return reply.code(404).send({ error: 'Certificate not found' });
      }
      return certificate;
    }

    const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 500);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const where = {
      customerId,
      ...(search
        ? {
            OR: [
              { certificateNo: { contains: search, mode: 'insensitive' as const } },
              { identification: { contains: search, mode: 'insensitive' as const } },
              { origin: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [certificates, count] = await Promise.all([
      prisma.certificate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        omit: { customerId: true },
      }),
      prisma.certificate.count({ where }),
    ]);
    return { certificates, count };
  }
);

const port = Number(process.env.PORT) || 4000;
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`mobile backend listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
