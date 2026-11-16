// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Sign in with a password or an email link, then go to the Hub. The link comes back to the Hub
 * with a one-time code (PKCE, supabase.ts), and the Hub exchanges it.
 */
import './backend';
import { getBackend } from '../../src/services/dbmn-backend/backend-config';
import { startTheme } from './shell/theme';
import { supabase, type SignInLinkProblem } from './supabase';

startTheme();   // #373: sign-in in the same theme as the Hub

const form = document.getElementById('signin-form') as HTMLFormElement;
const email = document.getElementById('email') as HTMLInputElement;
const password = document.getElementById('password') as HTMLInputElement;
const message = document.getElementById('signin-message') as HTMLElement;
const say = (text: string) => { message.textContent = text; };

const { profile, apiUrl } = getBackend();
// Which stack a dev page is on; production says nothing
const stack: Record<typeof profile, string> = {
    local: `Local stack (${apiUrl}). Local learner: learner@dbmn.local / puppy-school-local`,
    test: `Test stack (${apiUrl})`,
    production: ''
};
(document.getElementById('signin-backend') as HTMLElement).textContent = stack[profile];

// #376: the Hub sends a link that didn't sign in back here, saying why
const LINK_PROBLEMS: Record<SignInLinkProblem, string> = {
    elsewhere: 'That sign-in link was opened in a different browser from the one that asked for it. Open it in that browser, or send yourself a new link from here.',
    expired: 'That sign-in link has expired, has been used, or a newer link replaced it. Use the newest one in your email, or send yourself a new one from here.'
};
const problem = new URLSearchParams(location.search).get('link');
if (problem === 'elsewhere' || problem === 'expired') {
    say(LINK_PROBLEMS[problem]);
    history.replaceState(history.state, '', location.pathname);
}

void supabase().auth.getSession().then(({ data }) => {
    if (data.session) {
        location.replace('/');
    }
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    say('Signing in…');
    const { error } = await supabase().auth.signInWithPassword({ email: email.value.trim(), password: password.value });
    if (error) {
        say(error.message);
        return;
    }
    location.replace('/');
});

const linkButton = document.getElementById('signin-link') as HTMLButtonElement;

/**
 * The auth server sends a link at most once a minute per address and refuses sooner ones with
 * the seconds left ("…only request this after 51 seconds"). The button waits that long and the
 * message counts down, instead of the server's sentence standing still while the button works.
 */
function waitBeforeAnotherLink(seconds: number): void {
    linkButton.disabled = true;
    const until = Date.now() + seconds * 1000;
    const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) {
            linkButton.disabled = false;
            say('You can ask for another link now.');
            return;
        }
        say(`You can ask for another link in ${left} second${left === 1 ? '' : 's'}.`);
        // On the next whole second, so the count never skips or stalls
        setTimeout(tick, (until - Date.now()) % 1000 || 1000);
    };
    tick();
}

linkButton.addEventListener('click', async () => {
    if (!email.value.trim()) {
        say('Enter your email first.');
        return;
    }
    say('Sending…');
    linkButton.disabled = true;
    const { error } = await supabase().auth.signInWithOtp({
        email: email.value.trim(),
        options: { emailRedirectTo: `${location.origin}/` }
    });
    linkButton.disabled = false;
    if (error?.status === 429 || error?.code === 'over_email_send_rate_limit') {
        waitBeforeAnotherLink(Number(/(\d+) seconds?/.exec(error.message)?.[1] ?? 60));
        return;
    }
    say(error ? error.message : 'Check your email for the sign-in link.');
});
