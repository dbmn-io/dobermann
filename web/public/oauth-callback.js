/* Where an OAuth provider sends the browser back (oauth-callback.html, #343): hand the answer (code
 * or error) to the DBMN tab that asked (web/src/shell/oauth.ts), then close. A file, not inline
 * script, so the web app's Content Security Policy (#372) lets it run. */
(function () {
    var message = { type: 'dbmn-oauth-callback', url: location.href };
    try { new BroadcastChannel('dbmn-oauth').postMessage(message); } catch (e) { /* the opener below */ }
    try { if (window.opener) window.opener.postMessage(message, location.origin); } catch (e) { /* closed */ }
    setTimeout(function () {
        window.close();
        document.getElementById('oauth-callback-message').textContent = 'Done. You can close this window and go back to DBMN.';
    }, 300);
})();
