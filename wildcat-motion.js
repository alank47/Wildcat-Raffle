/* ============================================================
   WILDCAT MOTION — the JS half of the foundation
   ------------------------------------------------------------
   Ports of React Bits' CountUp / Counter, AnimatedContent /
   ScrollReveal / FadeContent, AnimatedList and ClickSpark, with
   the gsap and motion dependencies removed. No framework, no
   modules, no build. One global: `wcMotion`.

   Loads before or after script.js. Nothing here runs on its own
   except one passive `prefers-reduced-motion` listener; every
   effect is opt-in from a call site.

   THE THREE RULES THIS FILE OBEYS
   1. Idempotent. This app re-renders whole tables by assigning
      innerHTML, so every helper can be called again on the same
      container without stacking listeners, timers or classes.
   2. Never hide data. A helper that fails must leave content
      visible. Entrance animations use `animation-fill-mode: both`
      rather than a pre-set `opacity: 0`, so a dropped animation
      leaves the element painted, not blank. The one path that
      does pre-hide (scroll reveal) carries a 2s dead-man timer.
   3. Never show a number that is not true. See `count()`.
   ============================================================ */

(function (global, doc) {
    'use strict';

    if (global.wcMotion) return;            // idempotent at the file level too

    // --------------------------------------------------------
    // Environment
    // --------------------------------------------------------

    var reduceQuery = global.matchMedia
        ? global.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    var fineQuery = global.matchMedia
        ? global.matchMedia('(hover: hover) and (pointer: fine)')
        : null;

    function reduced() { return !!(reduceQuery && reduceQuery.matches); }
    function finePointer() { return !fineQuery || fineQuery.matches; }

    // --------------------------------------------------------
    // Easing
    // ------------------------------------------------------------
    // rb-standards.md ships --ease-out as cubic-bezier(0.23, 1,
    // 0.32, 1). The count-up runs in JS, so it needs the same
    // curve as a function or the numbers would ease on a
    // different curve from everything around them. This is a
    // Newton-Raphson solve of the same control points, so the CSS
    // token and the JS token are literally the same curve.
    // --------------------------------------------------------

    function cubicBezier(x1, y1, x2, y2) {
        function A(a, b) { return 1 - 3 * b + 3 * a; }
        function B(a, b) { return 3 * b - 6 * a; }
        function C(a) { return 3 * a; }
        function calc(t, a, b) { return ((A(a, b) * t + B(a, b)) * t + C(a)) * t; }
        function slope(t, a, b) { return 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a); }

        return function (x) {
            if (x <= 0) return 0;
            if (x >= 1) return 1;
            var t = x;
            for (var i = 0; i < 5; i++) {
                var d = slope(t, x1, x2);
                if (d === 0) break;
                t -= (calc(t, x1, x2) - x) / d;
            }
            return calc(t, y1, y2);
        };
    }

    var easeOut = cubicBezier(0.23, 1, 0.32, 1);

    // Duration tokens, mirroring wildcat-motion.css so the two
    // halves cannot drift.
    var DUR = {
        press: 160,
        menu: 200,
        pane: 180,
        modal: 260,
        enter: 260,
        count: 700,
        stagger: 45
    };

    // --------------------------------------------------------
    // Small helpers
    // --------------------------------------------------------

    function toArray(x) {
        if (!x) return [];
        if (typeof x === 'string') return Array.prototype.slice.call(doc.querySelectorAll(x));
        if (x.nodeType === 1) return [x];
        return Array.prototype.slice.call(x);
    }

    function onceAnimationEnd(el, cls, extra) {
        function done(e) {
            if (e && e.target !== el) return;      // ignore bubbling from children
            el.removeEventListener('animationend', done);
            el.removeEventListener('animationcancel', done);
            el.classList.remove(cls);
            if (extra) el.classList.remove(extra);
            el.style.removeProperty('--wcm-i');
            el.style.removeProperty('will-change');
        }
        el.addEventListener('animationend', done);
        el.addEventListener('animationcancel', done);
        // Dead-man timer. If the animation never fires the class is
        // still cleaned up, and because the class only ADDS an
        // animation the element was visible the whole time anyway.
        global.setTimeout(done, DUR.enter + DUR.stagger * 24 + 400);
    }

    // "Has this container already had its first paint animated?"
    //
    // This is the whole first-paint-only rule, and it is the single
    // most important guard in the file: the tables and boards it
    // protects are re-rendered on every ticket award and, for the
    // roster, on every keystroke of the search box.
    //
    // The flag lives on the CONTAINER, which survives the innerHTML
    // swap that destroys its rows — that is precisely why it works.
    // It is an attribute rather than a WeakSet entry for two
    // reasons: a caller can ask about the same container under
    // different keys without them colliding (a leaderboard body is
    // both staggered and counted), and the state is visible in
    // DevTools when something animates that should not.
    function firstTime(el, key) {
        if (!el) return false;
        var attr = 'data-wcm-first-' + key;
        if (el.hasAttribute(attr)) return false;
        el.setAttribute(attr, '1');
        return true;
    }

    // --------------------------------------------------------
    // 1. ENTER  — AnimatedContent / FadeContent port
    // --------------------------------------------------------
    // The class is applied immediately, not on a later frame.
    // `animation-fill-mode: both` in the CSS holds the from-state
    // during the stagger delay, so there is no flash and no
    // requestAnimationFrame dance to get wrong.
    //
    // `type` is one of fade | rise | blur | pop | row | pane.
    // --------------------------------------------------------

    function enter(target, opts) {
        opts = opts || {};
        var els = toArray(target);
        if (!els.length) return els;

        var type = opts.type || 'fade';
        var cls = 'wcm-' + type;
        var maxStagger = typeof opts.max === 'number' ? opts.max : 15;
        var step = typeof opts.from === 'number' ? opts.from : 0;

        els.forEach(function (el, i) {
            // Past the cap, no animation at all. A 50-row table does
            // not need 50 compositor animations, and rows past the
            // fold are never watched arriving. Bounding the count is
            // the difference between smooth and janky on a
            // Chromebook.
            if (i >= maxStagger) return;

            el.classList.remove(cls, 'wcm-in', 'wcm-stagger');
            // Force the removal to take effect so a repeat call
            // restarts the animation instead of being ignored.
            void el.offsetWidth;

            if (!opts.noStagger) {
                el.style.setProperty('--wcm-i', String(step + i));
                el.classList.add('wcm-stagger');
            }
            el.classList.add(cls, 'wcm-in');
            onceAnimationEnd(el, 'wcm-in', 'wcm-stagger');
        });

        return els;
    }

    // Stagger a list or a set of table rows — the AnimatedList
    // port. `once` is on by default and keyed on the CONTAINER,
    // which is what makes it safe to call from a render function
    // that fires on every keystroke.
    function staggerIn(container, opts) {
        opts = opts || {};
        var root = toArray(container)[0];
        if (!root) return;

        if (opts.once !== false && !firstTime(root, 'stagger')) return;

        var sel = opts.selector || ':scope > *';
        var els;
        try {
            els = Array.prototype.slice.call(root.querySelectorAll(sel));
        } catch (err) {
            els = Array.prototype.slice.call(root.children);
        }
        enter(els, {
            type: opts.type || 'row',
            max: typeof opts.max === 'number' ? opts.max : 15
        });
    }

    // --------------------------------------------------------
    // 2. REVEAL ON SCROLL — ScrollReveal / AnimatedContent port
    // --------------------------------------------------------
    // The gsap ScrollTrigger version is replaced with an
    // IntersectionObserver: no library, no scroll handler, and the
    // work happens off the scroll thread.
    //
    // Unlike AnimatedContent this fires ONCE per element and then
    // unobserves. Re-animating on every scroll pass, which is what
    // AnimatedList does, turns a long roster into a strobe.
    // --------------------------------------------------------

    var observer = null;

    function ensureObserver() {
        if (observer || typeof global.IntersectionObserver !== 'function') return observer;
        observer = new global.IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var el = entry.target;
                observer.unobserve(el);
                show(el);
            });
        }, { threshold: 0.1, rootMargin: '0px 0px -5% 0px' });
        return observer;
    }

    function show(el) {
        var type = el.getAttribute('data-wcm-reveal') || 'rise';
        el.classList.remove('wcm-pending');
        enter(el, { type: type, noStagger: true });
    }

    function reveal(target, opts) {
        opts = opts || {};
        var els = toArray(target);
        if (!els.length) return;

        // No observer support, or the user asked for less motion:
        // the content is simply there. Reduced motion still gets
        // the opacity fade further down, it just does not get
        // held back behind a viewport test.
        var io = reduced() ? null : ensureObserver();

        els.forEach(function (el, i) {
            if (el.hasAttribute('data-wcm-seen')) return;
            el.setAttribute('data-wcm-seen', '1');
            if (opts.type) el.setAttribute('data-wcm-reveal', opts.type);

            if (!io) { enter(el, { type: opts.type || 'fade', noStagger: true }); return; }

            el.classList.add('wcm-pending');
            io.observe(el);

            // Dead-man timer, rule 2. If the observer never fires —
            // a hidden ancestor, a detached subtree, a browser bug —
            // the content appears anyway. Data is never the price of
            // an animation.
            global.setTimeout(function () {
                if (el.classList.contains('wcm-pending')) {
                    if (observer) observer.unobserve(el);
                    show(el);
                }
            }, 2000 + i * 20);
        });
    }

    // --------------------------------------------------------
    // 3. COUNT — CountUp / Counter port
    // --------------------------------------------------------
    // CountUp drives a motion spring; Counter rolls ten stacked
    // copies of every digit. Neither ships here. What ships is the
    // part that matters: a number that arrives rather than
    // appears, on the same ease-out curve as everything else.
    //
    // THE HONESTY RULES. A number in this app is a student's
    // ticket balance or a roster count. Showing "37" on the way to
    // "412" is showing a teacher a wrong number, so:
    //
    //   a. Only a number arriving COLD animates. If the element
    //      already showed a value, the new value is written
    //      instantly. That is what keeps a count-up off the path
    //      of a teacher awarding a ticket 200 times a day — the
    //      first paint counts, every award after it snaps.
    //   b. Reduced motion snaps.
    //   c. A background tab snaps — no one is watching, and rAF
    //      is throttled there anyway.
    //   d. Small numbers snap. Counting 0-1-2-3 is not motion,
    //      it is a flicker.
    //   e. The accessible name is set to the FINAL value up front,
    //      so a screen reader announces the truth once instead of
    //      narrating the intermediate frames.
    //   f. The last frame assigns the exact target. The animation
    //      can never leave a number one off.
    // --------------------------------------------------------

    var running = [];
    var rafId = 0;

    function formatNumber(v, decimals, group) {
        if (group === false) return v.toFixed(decimals);
        try {
            return new Intl.NumberFormat('en-US', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            }).format(v);
        } catch (err) {
            return v.toFixed(decimals);
        }
    }

    function finalText(job) {
        return job.prefix + formatNumber(job.to, job.decimals, job.group) + job.suffix;
    }

    /** Write the true value and drop the job. Safe to call twice. */
    function finish(job) {
        var i = running.indexOf(job);
        if (i >= 0) running.splice(i, 1);
        if (job.el.isConnected) job.el.textContent = finalText(job);
        if (job.deadline) { global.clearTimeout(job.deadline); job.deadline = 0; }
    }

    function tick(now) {
        rafId = 0;
        for (var i = running.length - 1; i >= 0; i--) {
            var job = running[i];
            var t = (now - job.start) / job.duration;
            if (t >= 1 || !job.el.isConnected) { finish(job); continue; }
            var v = job.from + (job.to - job.from) * easeOut(t);
            job.el.textContent = job.prefix + formatNumber(v, job.decimals, job.group) + job.suffix;
        }
        if (running.length) rafId = global.requestAnimationFrame(tick);
    }

    function schedule() {
        if (!rafId && running.length) rafId = global.requestAnimationFrame(tick);
    }

    // Nothing may outlive its animation holding a half-counted number.
    //
    // requestAnimationFrame does not run in a backgrounded tab. If a tab
    // is hidden mid-count the loop simply stops, and the tile keeps
    // whatever partial value it had reached — a wrong number, parked on
    // screen, waiting for someone to come back to it. Two belts:
    //
    //   · every job carries a setTimeout deadline. Timers are throttled
    //     in the background but they still fire, so the true value lands
    //     even if not one animation frame ever arrives.
    //   · hiding the page finalises everything immediately. If no one is
    //     watching there is nothing to animate, and the tab should be
    //     showing the truth by the time it is looked at again.
    if (doc.addEventListener) {
        doc.addEventListener('visibilitychange', function () {
            if (!doc.hidden) return;
            while (running.length) finish(running[0]);
        });
    }

    function count(el, value, opts) {
        opts = opts || {};
        el = toArray(el)[0];
        if (!el) return;

        var to = Number(value);
        if (!isFinite(to)) { el.textContent = String(value); return; }

        var decimals = typeof opts.decimals === 'number' ? opts.decimals : 0;
        var group = opts.group !== false;
        var prefix = opts.prefix || '';
        var suffix = opts.suffix || '';
        var text = prefix + formatNumber(to, decimals, group) + suffix;

        el.classList.add('wcm-num');
        // Rule (e): the truth, once, for assistive tech.
        el.setAttribute('aria-label', text);

        // Drop any in-flight job for this element first, so a second
        // call cannot leave two animations fighting over textContent,
        // and cancel its deadline so a stale timer cannot later write
        // the PREVIOUS target over the current one.
        for (var i = running.length - 1; i >= 0; i--) {
            if (running[i].el !== el) continue;
            if (running[i].deadline) global.clearTimeout(running[i].deadline);
            running.splice(i, 1);
        }

        var cold = !el.hasAttribute('data-wcm-counted');
        el.setAttribute('data-wcm-counted', String(to));

        var snap =
            !cold ||                              // (a) a change, not an arrival
            opts.animate === false ||
            reduced() ||                          // (b)
            doc.hidden ||                         // (c)
            Math.abs(to) < 5 ||                   // (d)
            typeof global.requestAnimationFrame !== 'function';

        if (snap) { el.textContent = text; return; }

        var from = typeof opts.from === 'number' ? opts.from : 0;
        el.textContent = prefix + formatNumber(from, decimals, group) + suffix;

        var job = {
            el: el,
            from: from,
            to: to,
            decimals: decimals,
            group: group,
            prefix: prefix,
            suffix: suffix,
            start: (global.performance && performance.now ? performance.now() : Date.now()),
            duration: opts.duration || DUR.count,
            deadline: 0
        };
        job.deadline = global.setTimeout(function () { finish(job); }, job.duration + 500);
        running.push(job);
        schedule();
    }

    // Count every element inside `root` that carries a numeric
    // text node and the `data-wcm-count` marker. Used after an
    // innerHTML render, where individual elements are not
    // addressable.
    function countAll(root, opts) {
        var host = toArray(root)[0];
        if (!host) return;
        opts = opts || {};

        // The element-level "cold" test in count() cannot help here.
        // These numbers live inside markup that is thrown away and
        // rebuilt on every render, so every one of them looks like a
        // brand new element every time. Without this container-level
        // guard a leaderboard would re-count from zero on every
        // ticket a teacher awards — a wrong number on screen,
        // repeatedly, all day. The guard is the whole point of this
        // function existing rather than callers looping themselves.
        var cold = firstTime(host, 'count');
        var animate = opts.animate === false ? false : cold;

        var els = host.querySelectorAll('[data-wcm-count]');
        for (var i = 0; i < els.length; i++) {
            var raw = String(els[i].textContent || '').replace(/[^0-9.\-]/g, '');
            if (raw === '' || raw === '-') continue;
            count(els[i], parseFloat(raw), {
                animate: animate,
                decimals: opts.decimals,
                group: opts.group,
                duration: opts.duration
            });
        }
    }

    // Forget that a number was ever shown, so the next `count()`
    // treats it as a cold arrival again. Called when a modal is
    // opened on a different student: the tile is the same element,
    // but the value on it is genuinely new data arriving.
    function resetCount(target) {
        toArray(target).forEach(function (el) {
            el.removeAttribute('data-wcm-counted');
        });
    }

    // --------------------------------------------------------
    // 4. PANES — the tab / pane transition
    // --------------------------------------------------------

    function pane(target) {
        if (reduced()) {
            // Still crossfade; the CSS swaps the keyframe to a pure
            // opacity fade under prefers-reduced-motion.
            enter(target, { type: 'pane', noStagger: true });
            return;
        }
        enter(target, { type: 'pane', noStagger: true });
    }

    // --------------------------------------------------------
    // 5. SPOTLIGHT — SpotlightCard port
    // --------------------------------------------------------
    // The original writes --mouse-x / --mouse-y onto the card,
    // which invalidates style for every child on every mousemove.
    // rb-standards.md calls that out by name. Here a leaf <i> is
    // injected once per card and the variables land on it, so a
    // mousemove recalculates exactly one childless node.
    //
    // One delegated listener per container, not one per card, and
    // the write is coalesced into a frame.
    // --------------------------------------------------------

    var spotHosts = (typeof WeakSet === 'function') ? new WeakSet() : null;

    // Get, or create, one effect layer of a given kind on a card.
    // Idempotent, and cheap to call again after the card's
    // innerHTML has been rewritten — which is exactly when the
    // layer needs putting back.
    function fxLayer(card, kind) {
        card.classList.add('wcm-fx-host');
        // The layer is absolutely positioned, so it needs a positioned
        // ancestor — but only add one if the card does not already have
        // one. The student portal's cards are `position: absolute` and
        // laid out by hand; forcing `relative` on them would flatten the
        // stack.
        if (!card.classList.contains('wcm-fx-relative') && global.getComputedStyle &&
            global.getComputedStyle(card).position === 'static') {
            card.classList.add('wcm-fx-relative');
        }
        var cls = 'wcm-fx-' + kind;
        var layer = null;
        for (var i = 0; i < card.children.length; i++) {
            if (card.children[i].classList.contains(cls)) { layer = card.children[i]; break; }
        }
        if (!layer) {
            layer = doc.createElement('i');
            layer.className = 'wcm-fx ' + cls;
            layer.setAttribute('aria-hidden', 'true');
            card.appendChild(layer);
        }
        return layer;
    }

    // Attach one or more card treatments. kinds is any of
    // 'spot' | 'glare' | 'star'.
    function fx(target, kinds) {
        var list = (kinds || 'spot').split(/\s+/);
        return toArray(target).map(function (card) {
            var made = {};
            list.forEach(function (kind) {
                if (!kind) return;
                // Decorative-only treatments are simply not built
                // when the user has asked for less motion or is on a
                // touch pointer. Not built, not just hidden — the
                // node never exists.
                if ((kind === 'spot' || kind === 'glare') && (reduced() || !finePointer())) return;
                if (kind === 'star' && reduced()) return;
                made[kind] = fxLayer(card, kind);
            });
            return made;
        });
    }

    function spotlight(container, opts) {
        opts = opts || {};
        var root = toArray(container)[0];
        if (!root || !finePointer() || reduced()) return;

        var cardSel = opts.selector || '.wcm-fx-host';

        if (spotHosts && spotHosts.has(root)) return;   // listener already attached
        if (spotHosts) spotHosts.add(root);

        var pending = null;
        var frame = 0;

        function paint() {
            frame = 0;
            if (!pending) return;
            var layer = fxLayer(pending.card, 'spot');
            layer.style.setProperty('--wcm-x', pending.x + 'px');
            layer.style.setProperty('--wcm-y', pending.y + 'px');
            pending = null;
        }

        // One delegated listener on the container, not one per
        // card, and the write is coalesced into a frame so a fast
        // mouse cannot queue more work than the display can show.
        root.addEventListener('pointermove', function (e) {
            if (e.pointerType !== 'mouse') return;      // no false hover from a tap
            if (opts.skip && opts.skip()) return;       // e.g. a drag in flight
            var card = e.target.closest ? e.target.closest(cardSel) : null;
            if (!card) return;
            var r = card.getBoundingClientRect();
            pending = { card: card, x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
            if (!frame) frame = global.requestAnimationFrame(paint);
        }, { passive: true });
    }

    // --------------------------------------------------------
    // 6. CLICK SPARK — ported faithfully
    // --------------------------------------------------------
    // The React Bits component is already dependency-free canvas,
    // so this is a direct translation: same eight sparks, same
    // 15px radius, same 10px line that shortens as it travels,
    // same 400ms, same `t * (2 - t)` ease-out.
    //
    // Two things are added, both required by this app rather than
    // by the component: the rAF loop only runs while sparks exist
    // (the original leaves a frame loop running forever), and it
    // is a no-op under prefers-reduced-motion.
    // --------------------------------------------------------

    var sparkHosts = (typeof WeakSet === 'function') ? new WeakSet() : null;

    function clickSpark(target, opts) {
        opts = opts || {};
        toArray(target).forEach(function (host) {
            if (sparkHosts && sparkHosts.has(host)) return;
            if (sparkHosts) sparkHosts.add(host);

            var color = opts.sparkColor || '#E6E280';   // school yellow, not React Bits' #fff
            var size = opts.sparkSize || 10;
            var radius = opts.sparkRadius || 15;
            var countN = opts.sparkCount || 8;
            var duration = opts.duration || 400;
            var scale = opts.extraScale || 1.0;

            host.classList.add('wcm-spark-host');

            var canvas = null;
            var ctx = null;
            var sparks = [];
            var loop = 0;

            function fit() {
                var r = host.getBoundingClientRect();
                var w = Math.max(1, Math.round(r.width));
                var h = Math.max(1, Math.round(r.height));
                if (canvas.width !== w || canvas.height !== h) {
                    canvas.width = w;
                    canvas.height = h;
                }
            }

            function draw(now) {
                loop = 0;
                if (!ctx) return;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                sparks = sparks.filter(function (s) {
                    var elapsed = now - s.t;
                    if (elapsed >= duration) return false;
                    var p = elapsed / duration;
                    var e = p * (2 - p);                       // the component's own ease-out
                    var dist = e * radius * scale;
                    var len = size * (1 - e);
                    var x1 = s.x + dist * Math.cos(s.a);
                    var y1 = s.y + dist * Math.sin(s.a);
                    var x2 = s.x + (dist + len) * Math.cos(s.a);
                    var y2 = s.y + (dist + len) * Math.sin(s.a);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                    return true;
                });
                if (sparks.length) {
                    loop = global.requestAnimationFrame(draw);
                } else if (canvas && canvas.parentNode) {
                    // Idle: take the canvas back out. Nothing of ours
                    // sits over a live control between celebrations.
                    canvas.parentNode.removeChild(canvas);
                    canvas = null;
                    ctx = null;
                }
            }

            host.addEventListener('click', function (e) {
                if (reduced()) return;
                if (!canvas) {
                    canvas = doc.createElement('canvas');
                    canvas.className = 'wcm-spark';
                    canvas.setAttribute('aria-hidden', 'true');
                    host.appendChild(canvas);
                    ctx = canvas.getContext('2d');
                }
                fit();
                var r = canvas.getBoundingClientRect();
                var x = e.clientX - r.left;
                var y = e.clientY - r.top;
                var now = (global.performance && performance.now ? performance.now() : Date.now());
                for (var i = 0; i < countN; i++) {
                    sparks.push({ x: x, y: y, a: (2 * Math.PI * i) / countN, t: now });
                }
                if (!loop) loop = global.requestAnimationFrame(draw);
            });
        });
    }

    // --------------------------------------------------------
    // 7. PRESS
    // --------------------------------------------------------
    // Adds the class; the transform lives in CSS. Idempotent by
    // construction — classList.add on an element that already has
    // it does nothing.
    // --------------------------------------------------------

    function press(target) {
        toArray(target).forEach(function (el) { el.classList.add('wcm-press'); });
    }

    // --------------------------------------------------------
    // Export
    // --------------------------------------------------------

    global.wcMotion = {
        enter: enter,
        stagger: staggerIn,
        reveal: reveal,
        count: count,
        countAll: countAll,
        resetCount: resetCount,
        pane: pane,
        fx: fx,
        spotlight: spotlight,
        clickSpark: clickSpark,
        press: press,
        reduced: reduced,
        finePointer: finePointer,
        ease: easeOut,
        DUR: DUR
    };

})(window, document);
