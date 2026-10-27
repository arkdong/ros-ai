/** /kit/preact.js: Preact with htm, for pages that keep their own state, as the global preact
 * (preact.html, preact.render, preact.useState and the other hooks). No build step: html`<div>…</div>`. */
import * as preact from 'htm/preact/standalone';

Object.assign(window, { preact });
