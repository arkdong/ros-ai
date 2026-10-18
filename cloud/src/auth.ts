import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization, organization } from 'better-auth/plugins';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Better Auth owns the user, session, organisation and device-code tables in our own Postgres.
 * The app signs in with a device code (the browser approves it), then sends the session token
 * as a bearer token; the gateway only ever asks "whose token is this". */
export const auth = betterAuth({
  appName: 'ros.ai',
  baseURL: config.publicUrl,
  secret: config.secret,
  database: pool,
  trustedOrigins: [config.publicUrl],
  emailAndPassword: { enabled: config.emailPassword, minPasswordLength: 12 },
  socialProviders: { ...(config.github ? { github: config.github } : {}), ...(config.google ? { google: config.google } : {}) },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  // Kept in memory: one service instance, and the database table's bigint column only produced a warning.
  rateLimit: { enabled: true, window: 60, max: 60, storage: 'memory' },
  plugins: [
    bearer(),
    organization({ allowUserToCreateOrganization: true }),
    deviceAuthorization({ expiresIn: '10m', interval: '5s', verificationUri: '/device', validateClient: clientId => clientId === config.appClientId }),
  ],
  databaseHooks: {
    user: {
      create: {
        // Allowance, usage and later billing belong to an organisation, so everyone starts with one.
        after: async user => {
          await auth.api.createOrganization({ body: { name: `${user.name || user.email.split('@')[0]}'s workspace`, slug: `personal-${randomBytes(6).toString('hex')}`, userId: user.id, metadata: { personal: true } } });
        },
      },
    },
  },
});

/** The person and organisation behind a request's bearer token, or null. */
export async function caller(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  let orgId = session.session.activeOrganizationId ?? null;
  if (!orgId) {
    const row = await pool.query<{ organizationId: string }>('select "organizationId" from member where "userId" = $1 order by "createdAt" limit 1', [session.user.id]);
    orgId = row.rows[0]?.organizationId ?? null;
  }
  return orgId ? { userId: session.user.id, email: session.user.email, name: session.user.name, orgId, sessionId: session.session.id } : null;
}
