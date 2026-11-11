/** Google's map script keeps the key it was loaded with until the page is loaded again, so a key saved after
 * that reaches the maps only with a reload. This says whether the script has been loaded on this page. */
let loaded = false;
export const googleMapsScriptLoaded = () => loaded;
export const markGoogleMapsScriptLoaded = () => { loaded = true; };
