import { AppHost } from './app-host';

/** The page ros_check_app opens in a hidden browser: one App in its sealed frame, with the same host code as the
 * canvas. Its token and frame address arrive in the address's fragment, which is never sent to a server. */
const { token, url, title } = JSON.parse(decodeURIComponent(location.hash.slice(1))) as { token: string; url: string; title: string };
new AppHost(document.body, token, url, `App: ${title}`);
