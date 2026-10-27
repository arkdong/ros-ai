/** Shared by blocks read live from another app (Notion, Google Sheets and Docs). */

/** When it was read: the time today, with the date on another day (a read kept across restarts). */
export const clock = (at: string) => { const date = new Date(at), time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`; };
/** A click inside the block that is not a click on the canvas card. */
export const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
