# pi-subscription-usage

Subscription usage for every account of every provider in [Pi](https://pi.dev): Anthropic
(Claude), OpenAI (ChatGPT/Codex), GitHub Copilot, OpenRouter, xAI SuperGrok, Kimi Coding Plan
and OpenCode Go/Zen.

## Install

```bash
pi install git:github.com/kacperkwapisz/pi-subscription-usage
```

Requires Pi 1.x.

## Use

```text
/subscriptions
```

Opens a tabbed view with one tab per provider. Each tab shows every logged-in account with
its usage windows (e.g. 5-hour and weekly), reset times, and — where the provider reports
them — email and plan.

- `Tab` / `←` `→` switch providers, `r` refreshes, `Esc` closes.
- `s` opens settings: which providers to show, **used vs. remaining**, relative or absolute
  reset times, and bar markers.

Settings are saved to `~/.pi/agent/subscription-meter.json`.

## Multiple accounts

Accounts are found from Pi's logins: a provider's own login (`anthropic`) plus numbered
extra accounts (`anthropic-account-2`, …), as created by
[pi-multi-account](https://github.com/kacperkwapisz/pi-multi-account). ChatGPT accounts from
Pi's **Sign in with ChatGPT** (`openai`) appear in the OpenAI/Codex tab. The same account
logged in twice is marked as such.

Tokens come from Pi, so expired logins are refreshed by Pi exactly as for normal requests.

## Data sources

Most providers have no official usage API. This extension uses the same endpoints their own
apps use; these are undocumented and can change without notice. When a response can't be
read, the account shows an error instead of guessed numbers.

## Development

```bash
npm install
npm run check
npm test
```
