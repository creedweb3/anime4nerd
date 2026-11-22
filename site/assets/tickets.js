// Ticket codes this browser holds, on every page of the site.
//
// A report (or an uninstall answer with a note) hands out one ticket code, and the link
// /r/<code> is the same code. The codes live only in this browser's localStorage ("a4n-tickets");
// nothing about the visitor is stored on the server. This script:
//   - adds a "tickets" chip to the top bar, only when this browser holds a code, with a square
//     count of unread replies (one POST /api/tickets, cached for a few minutes);
//   - gives the form pages window.a4nTickets.box(code) for their thank-you screen.
// Everything from the server is put on screen as text, never as HTML.
(function () {
  var KEY = 'a4n-tickets';
  var COUNT_KEY = 'a4n-tickets-unseen';
  var COUNT_MS = 5 * 60 * 1000;
  var MAX = 20; // codes kept in this browser (read from /api/tickets in batches of 6)
  var CODE = /^A4N-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

  var read = function () {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (c) { return typeof c === 'string' && CODE.test(c); }).slice(0, MAX) : [];
    } catch (e) { return []; }
  };
  var write = function (codes) {
    try { localStorage.setItem(KEY, JSON.stringify(codes.slice(0, MAX))); } catch (e) { /* private window: codes live only on screen */ }
    try { sessionStorage.removeItem(COUNT_KEY); } catch (e) { /* nothing cached */ }
    // Tells the Anime4Nerd extension, if installed, whether there are tickets (its report icon then opens them).
    document.dispatchEvent(new Event('a4n-tickets'));
  };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Newest first; an existing code moves to the front.
  var add = function (code) {
    if (!CODE.test(code)) return;
    write([code].concat(read().filter(function (c) { return c !== code; })));
    chip();
  };
  var remove = function (code) { write(read().filter(function (c) { return c !== code; })); chip(); };

  var copyButton = function (value) {
    var b = el('button', 'btn', 'copy');
    b.type = 'button';
    b.addEventListener('click', function () {
      var done = function () { b.textContent = 'copied'; setTimeout(function () { b.textContent = 'copy'; }, 1200); };
      if (navigator.clipboard) navigator.clipboard.writeText(value).then(done, function () {});
    });
    return b;
  };

  // The thank-you box: the link and the code on two rows, each with copy; the link also opens.
  var box = function (code, bye) {
    var link = location.origin + '/r/' + code;
    var wrap = el('div', 'tk-box');
    var head = el('div', 'phead');
    head.append(el('span', null, 'your ticket'), el('span', null, 'keep it'));
    var row1 = el('div', 'tk-row');
    var open = el('a', 'btn tk-open', 'open');
    open.href = '/r/' + code;
    row1.append(el('span', 'k', 'link'), el('code', null, link), copyButton(link), open);
    var row2 = el('div', 'tk-row');
    row2.append(el('span', 'k', 'code'), el('code', 'tk-code', code), copyButton(code), el('span'));
    var line = el('p', 'tk-line', 'Same ticket. On another device, type the code at tickets in the top bar.');
    var p = el('p', 'tk-text');
    p.textContent = bye
      ? 'If we fix what made you leave, we will say so there, and you can write back. Saved in this browser too. No account: whoever has the code can read the conversation.'
      : 'Open it any time to see replies and write back. Saved in this browser too: the bug icon in the extension then opens your tickets. No account: whoever has the code can read the conversation.';
    wrap.append(head, row1, row2, line, p);
    return wrap;
  };

  // The top-bar chip, after "report"; absent while this browser holds no code.
  var chip = function () {
    var nav = document.querySelector('.top .nav');
    if (!nav) return;
    var old = nav.querySelector('.chip.tickets');
    if (old) old.remove();
    var codes = read();
    if (!codes.length) return;
    var a = el('a', 'chip tickets', 'tickets');
    a.href = '/tickets';
    if (/^\/(tickets|r\/)/.test(location.pathname)) a.setAttribute('aria-current', 'page');
    var report = nav.querySelector('a[href$="report"]');
    if (report) report.after(a); else nav.append(a);
    badge(a, codes);
  };

  // /api/tickets reads at most 6 codes a request (Cloudflare's per-request limit): send batches.
  var BATCH = 6;
  var fetchAll = function (codes, seen) {
    var batches = [];
    for (var i = 0; i < codes.length; i += BATCH) batches.push(codes.slice(i, i + BATCH));
    return Promise.all(batches.map(function (b) {
      var body = { codes: b };
      if (seen && b.indexOf(seen) >= 0) body.seen = seen;
      return fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
        .then(function (j) { return Array.isArray(j.tickets) ? j.tickets : []; });
    })).then(function (parts) { return [].concat.apply([], parts); });
  };

  var badge = function (a, codes) {
    var show = function (n) {
      if (!n) return;
      var i = el('i', null, String(Math.min(n, 9)));
      a.append(i);
      a.setAttribute('aria-label', 'tickets, ' + n + ' new ' + (n === 1 ? 'reply' : 'replies'));
    };
    try {
      var c = JSON.parse(sessionStorage.getItem(COUNT_KEY) || 'null');
      if (c && c.k === codes.join() && Date.now() - c.t < COUNT_MS) return show(c.n);
    } catch (e) { /* no cache */ }
    fetchAll(codes)
      .then(function (tickets) {
        var n = tickets.reduce(function (s, t) { return s + (Number.isInteger(t.unseen) ? t.unseen : 0); }, 0);
        try { sessionStorage.setItem(COUNT_KEY, JSON.stringify({ k: codes.join(), t: Date.now(), n: n })); } catch (e) { /* no cache */ }
        show(n);
      }, function () {});
  };

  // After the tickets page marks replies read: drop the cached count and draw the chip again.
  var refresh = function () {
    try { sessionStorage.removeItem(COUNT_KEY); } catch (e) { /* nothing cached */ }
    chip();
  };

  window.a4nTickets = { list: read, add: add, remove: remove, box: box, refresh: refresh, fetchAll: fetchAll, CODE: CODE };
  chip();
})();
