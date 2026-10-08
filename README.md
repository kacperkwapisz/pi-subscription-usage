# pi-subscription-usage

See how much of your subscription limits you've used, for every account, without leaving
[Pi](https://pi.dev). Works with Claude, ChatGPT, GitHub Copilot, OpenRouter, xAI SuperGrok,
Kimi Coding Plan and OpenCode.

## Install

```bash
pi install git:github.com/kacperkwapisz/pi-subscription-usage
```

Requires Pi 1.x.

## Use

Run `/usage` (`/subscriptions` works too). There's a tab per provider, and each tab lists
your accounts with their limits, how much is used, when each one resets, and the email and
plan when the provider tells us.

You only see providers you actually have. A tab shows up once you log in, or add an API key
for OpenRouter or OpenCode, and a provider that turns out to have no subscription behind
your login is hidden for the rest of the session.

Keys: `Tab` or the arrow keys switch providers, `r` refreshes, `s` opens settings, `Esc`
closes. In settings you can choose whether bars show what's used or what's left, relative or
absolute reset times, and which providers may appear. Settings are saved in
`~/.pi/agent/subscription-usage.json`.

## Several accounts

Every login of a provider counts as an account: its own (`anthropic`) and numbered extras
(`anthropic-account-2`), which is what
[pi-multi-account](https://github.com/kacperkwapisz/pi-multi-account) creates. ChatGPT logins
from Pi's Sign in with ChatGPT appear in the ChatGPT tab. If you've logged into the same
account twice, the second one says so.

With pi-multi-account installed, you can also switch accounts here: pick one with the up and
down arrows and press Enter. Without it, the view only shows usage. The two find each other
over Pi's `pi.events` bus, and neither needs the other.

Pi supplies the login tokens and refreshes them when they expire, the same as for normal
requests.

## Where the numbers come from

Most providers don't publish a usage API, so this asks the same endpoints their own apps use.
Those aren't documented and can change. If a reply can't be read, you get an error for that
account rather than made-up numbers.

## Development

```bash
npm install
npm run check
npm test
```
