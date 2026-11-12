// Sends a form's answers to /api/send after an invisible Cloudflare Turnstile check.
// Used by /uninstalled and /report. Turnstile loads only once the visitor starts using the form,
// and answers are sent only when they press send.
(function () {
  var TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
  var TOKEN_TIMEOUT_MS = 60000;
  var LOAD_TIMEOUT_MS = 15000;
  var box = document.getElementById('ts');
  var form = box.closest('form');
  var id = null;
  var loading = null;
  var waiting = null;

  var settle = function (fn, value) {
    if (!waiting) return;
    var w = waiting;
    waiting = null;
    clearTimeout(w.timer);
    w[fn](value);
  };

  // Loads Turnstile once and resolves when the widget is ready.
  var load = function () {
    if (loading) return loading;
    loading = new Promise(function (ok, no) {
      window.onTurnstileLoad = function () {
        id = window.turnstile.render(box, {
          sitekey: box.dataset.sitekey,
          action: box.dataset.action,
          execution: 'execute',
          appearance: 'interaction-only',
          callback: function (token) { settle('ok', token); },
          'error-callback': function () { settle('no', new Error('turnstile')); },
          'expired-callback': function () { settle('no', new Error('turnstile')); },
        });
        ok();
      };
      var s = document.createElement('script');
      s.src = TURNSTILE;
      s.async = true;
      s.onerror = function () { loading = null; no(new Error('turnstile')); };
      document.head.append(s);
    });
    return loading;
  };
  ['pointerdown', 'focusin', 'keydown'].forEach(function (type) {
    form.addEventListener(type, function () { load().catch(function () {}); }, { once: true });
  });

  // A stalled Turnstile script must not leave the form on "sending…": give up on this send after
  // LOAD_TIMEOUT_MS. The script keeps loading, so a later send can still use it.
  var loaded = function () {
    return Promise.race([load(), new Promise(function (ok, no) {
      setTimeout(function () { no(new Error('turnstile')); }, LOAD_TIMEOUT_MS);
    })]);
  };

  var token = function () {
    return loaded().then(function () {
      return new Promise(function (ok, no) {
        settle('no', new Error('superseded'));
        waiting = { ok: ok, no: no, timer: setTimeout(function () { settle('no', new Error('timeout')); }, TOKEN_TIMEOUT_MS) };
        window.turnstile.reset(id);
        window.turnstile.execute(id);
      });
    });
  };

  // Resolves on success; rejects with an Error whose message is the server's error code.
  window.a4nSend = function (payload) {
    return token().then(function (t) {
      return fetch('/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, payload, { token: t })),
      });
    }).then(function (res) {
      if (res.ok) return;
      return res.json().catch(function () { return {}; }).then(function (b) { throw new Error(b.error || 'http_' + res.status); });
    });
  };

  // Reads ?v= (and ?b=) from the link the extension opened, keeping only well-formed values.
  var q = new URLSearchParams(location.search);
  window.a4nEnv = {
    v: /^\d+\.\d+\.\d+$/.test(q.get('v') || '') ? q.get('v') : '',
    b: ['chrome', 'firefox'].indexOf(q.get('b')) >= 0 ? q.get('b') : '',
  };

  window.a4nError = function (err, el) {
    el.textContent = /limit/.test(err.message)
      ? 'Too many answers today. Please try again tomorrow.'
      : /^shot_/.test(err.message)
        ? "Couldn't read screenshot " + err.message.slice(5) + '. It was removed; press send again.'
        : err.message === 'bad_shot'
          ? "The screenshots couldn't be used and were removed. Press send again to send the text."
          : "Couldn't send right now. Please try again in a moment.";
    el.hidden = false;
  };
})();
