import type express from 'express';
import * as Sentry from '@sentry/node';

/** Error reports for the cloud service, on only when SENTRY_DSN is set. Errors only, no tracing,
 * and every report is stripped of request bodies, cookies, headers and addresses, so prompts and
 * tokens never leave this service. Imported first, before anything else loads. */
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? 'development',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) event.request = { method: event.request.method, url: event.request.url?.split('?')[0] };
      if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
      delete event.server_name;
      return event;
    },
    beforeBreadcrumb: breadcrumb => (breadcrumb.category === 'http' || breadcrumb.category === 'console' ? null : breadcrumb),
  });
}

/** Sends errors that reach Express's error handling to Sentry, when it is on. */
export function reportErrors(app: express.Express) {
  if (dsn) Sentry.setupExpressErrorHandler(app);
}
