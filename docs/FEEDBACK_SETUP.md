# Feedback forms: Cloudflare setup

The site's `/uninstalled` and `/report` forms post to `functions/api/send.js`, a Cloudflare Pages
Function. It stores answers in Workers KV and checks Cloudflare Turnstile. Until the steps below
are done the endpoint answers `503 not_configured`, and the forms show their error message: no
answer is ever faked as sent.

Everything here is on the Free plan and needs no payment method. Past a Free-plan quota, requests or
writes fail; nothing is billed. Do not switch the account to Workers Paid.

## 1. Check the Pages build settings

Workers & Pages → **anime4nerd** → Settings → Build:

- Root directory: empty (the repository root). Pages only finds `functions/` in the root directory.
- Build command: `node site/build.mjs`
- Build output directory: `site/public`

## 2. Create the Turnstile widget

Dashboard home → **Turnstile** → **Add widget**:

1. Widget name: `anime4nerd forms`.
2. Hostnames: add `anime4nerd.pages.dev`. A hostname also covers its subdomains, so preview
   deploys (`<hash>.anime4nerd.pages.dev`) pass too; if a preview answers `403 not_verified`, add
   its hostname here.
3. Widget mode: **Managed**. The pages render it with `appearance: interaction-only`, which needs
   Managed mode: most visitors see nothing, and only a suspicious one gets a checkbox.
4. Create. Keep the page open: it shows the **Site key** and the **Secret key**.

## 3. Create the KV namespace

Storage & Databases → **KV** → **Create a namespace** → name `anime4nerd-feedback` → Add.

## 4. Add variables, secrets and the binding

Workers & Pages → **anime4nerd** → Settings. Do each of these for **Production**, and again for
**Preview** if preview deploys should work too:

1. Variables and Secrets → **Add**:
   - Type *Text*, name `TURNSTILE_SITEKEY`, value: the site key. The build writes it into the pages,
     and a Pages build without it fails on purpose.
   - Type *Secret*, name `TURNSTILE_SECRET`, value: the secret key.
   - Type *Secret*, name `IP_SALT`, value: a long random string, for example the output of
     `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`.
2. Bindings → **Add** → **KV namespace** → variable name `FEEDBACK`, namespace `anime4nerd-feedback` → Save.

Then Deployments → latest deployment → **Retry deployment** (bindings and variables apply only to
new deployments).

## 5. Check it

Open https://anime4nerd.pages.dev/uninstalled, tick a reason, press send. It should show
"Thanks, that helps." and a key `uninstall:…` should appear under KV → `anime4nerd-feedback` →
KV Pairs.

Then open https://anime4nerd.pages.dev/report, describe a test problem, add three large
screenshots and send. Check that:

- the browser console shows no Content-Security-Policy errors (the live Turnstile key is the only
  part local tests cannot cover). Per Cloudflare's Turnstile CSP reference the form pages allow
  `script-src` and `frame-src https://challenges.cloudflare.com`; `connect-src` stays `'self'`
  because pre-clearance is off. Inline scripts are allowed only by their SHA-256 hash, so if anything
  ever rewrote the HTML in transit (Cloudflare features such as Rocket Loader or email obfuscation
  on a custom domain), the scripts would be blocked rather than run: the forms fail closed;
- Workers & Pages → **anime4nerd** → Functions → metrics show no errors and CPU time under 10 ms.

Delete the test keys from KV afterwards.

## Reading answers

- Answers: keys `uninstall:<time>-<id>` and `report:<time>-<id>`, each a JSON value with
  `kind`, `reasons`, `note`, `v`, `b` (report only), `at` (cut to the minute), `shots` (count) and,
  when the daily screenshot ceiling dropped some, `shotsDropped`. Treat every value as
  untrusted text: never paste it into HTML or run it.
- Screenshots: keys `shot:<same time-id>:1` to `:3`, raw JPEG bytes, deleted automatically after
  60 days (text answers stay until you delete them). The server accepts only the headers a browser
  canvas writes (JFIF, ICC profile, tables, frame); EXIF, XMP and comment segments are refused.
  The compressed image data itself is not decoded, so open screenshots in an up-to-date image
  viewer, never in a browser tab or tool that might treat them as anything else. The dashboard cannot show
  images; save one with
  `npx wrangler kv key get "shot:<time-id>:1" --namespace-id <namespace id> --remote > shot.jpg`.
- Counters: keys `rl:<day>:…` expire by themselves after two days.

## Limits

The tradeoff, said plainly: the daily totals protect the Free-plan quotas, so someone who gets
past Turnstile from many IP addresses can use up a day's total for one form, and genuine answers
are then refused (with a clear message) until the next UTC day. Nothing is billed and nothing
already stored is lost. KV counters are read, then written, so parallel requests can overshoot a
cap slightly; if that ever reaches a Free-plan KV quota, the function answers 503 "unavailable"
rather than failing. Every refused request logs one line with its code only (no body, IP or
headers), visible under Workers & Pages → anime4nerd → Functions → logs.


- 5 answers and 3 screenshots per visitor per UTC day, counted under a daily-rotating salted
  SHA-256 of the IP (IPv6: of its /64 network). A request without Cloudflare's CF-Connecting-IP
  header is refused. 60 uninstall answers, 60 reports and 30 screenshots per day in total, each
  form counted separately so a flood of one leaves the other working; past a screenshot
  ceiling the text is still stored. KV counters are eventually consistent, so a burst of parallel
  requests can exceed them slightly; every request still needs its own Turnstile token, and the
  daily totals bound the damage.
- Body at most 1.05 MB; up to 3 JPEG screenshots of at most 260 KB each (the page re-encodes to
  at most 250 KB). A maximum-size report takes about 5 ms in local tests, under the 10 ms CPU limit.
- Free-plan quotas that apply: Functions 100,000 requests/day and 10 ms CPU per request, KV 1,000
  writes/day and 1 GB stored. One answer uses 3 writes, plus 1 per screenshot and 2 more when it
  has screenshots, so the daily ceilings stay under about 450 writes; 30 screenshots a day kept 60
  days stay under about 470 MB. Screenshots are decoded only after Turnstile, so the CPU cost of a
  large report is paid only for verified visitors; check CPU time after deploy (step 5).
- A Cloudflare WAF rate-limiting rule is not possible here: WAF rules need a zone (custom domain)
  on the account, and `pages.dev` is Cloudflare's. With a custom domain later, add one rule on
  `/api/*` under Security → WAF → Rate limiting rules.

## Local testing

Build the site, then run Wrangler with Turnstile's always-pass test secret and a local KV:

```
node site/build.mjs
npx wrangler@4.155.0 pages dev site/public --port 8788 --kv FEEDBACK --binding TURNSTILE_SECRET=1x0000000000000000000000000000000AA --binding IP_SALT=local-test-salt --binding ALLOW_TEST_TURNSTILE=1
```

- `node --test test/send-api.mjs`: unit tests of the function (no server needed).
- `node test/send-dev.mjs http://localhost:8788`: abuse checks against the running dev server
  (uses up the local daily cap).
