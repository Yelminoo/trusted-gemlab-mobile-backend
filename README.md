# Trusted Gemlab — Mobile Backend (standalone)

Fastify + Prisma + PostgreSQL API for the Trusted Gemlab mobile app.

Split out from the `mobile-point` Expo project's `backend/` folder to run as
its own independently-hosted service, with its own database — no longer
shares data with `web-internal`.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npx prisma generate
npx prisma migrate dev
npm run dev
```

## Production deploy

```bash
npm ci
npm run build
npx prisma generate
npx prisma migrate deploy
npm start
```

See `.env.example` for required environment variables.
