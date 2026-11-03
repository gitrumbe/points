/**
 * Points Tracker core logic.
 * The SAME code runs in the dashboard page and in the Apps Script, so points are
 * always worked out the same way. No page or Sheet code in here.
 */
var PointsCore = (function () {
  var ROUTINES = [
    { k: 'before', name: 'Before school', icon: '🌅', rule: 'before' },
    { k: 'after',  name: 'After school',  icon: '🏫', rule: 'after' },
    { k: 'night',  name: 'Night',         icon: '🌙', rule: 'night' },
    { k: 'chores', name: 'Weekly chores', icon: '🏠', rule: 'chores' },
    { k: 'wkmorn', name: 'Weekend morning', icon: '🌞', rule: 'wkmorn' },
    { k: 'monday', name: 'Ready for Monday', icon: '🎒', rule: 'monday' }
  ];
  var MEM_ROUT = ['before', 'after', 'night'];
  var MEM_LEVELS = [1, 5, 10, 20, 40];
  var SELF_LEVELS = [5, 10, 20, 40, 80];
  var STREAK_LEVELS = [5, 10, 20, 40, 60];
  var GIRLS = ['ayla', 'lani'];
  var GIRL_NAMES = { ayla: 'Ayla', lani: 'Lani' };
  // Reasons a parent can take a point away (the girls see these words).
  var DED_REASONS = ['Lying', 'Rude or disrespectful', 'Ignoring a warning', 'Not following instructions', 'Asked for help before trying'];
  // Reasons for a warning (the girls see these words). Ignoring a warning turns it into a strike.
  var WARN_REASONS = ['Not following instructions', 'Not listening', 'Dragging it out'];
  // Which routines belong to a day (for the no-chasing bonus): weekdays, Saturday, Sunday.
  function ownKeys(w) { return w >= 1 && w <= 5 ? ['before', 'after', 'night'] : w === 6 ? ['wkmorn', 'night'] : ['wkmorn', 'monday', 'night']; }
  // The routine that has to be finished before Night unlocks (none on Saturday).
  function nightGate(w) { return w >= 1 && w <= 5 ? 'after' : w === 0 ? 'monday' : null; }

  /* ---------- dates (all as 'yyyy-mm-dd' text) ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function toD(s) { return new Date(s + 'T12:00:00Z'); }
  function fmt(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function add(s, n) { var d = toD(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
  function dow(s) { return toD(s).getUTCDay(); }
  function isWk(s) { var w = dow(s); return w >= 1 && w <= 5; }
  function weekStart(s) { return add(s, -((dow(s) + 6) % 7)); }
  // A task can be left off some weekdays (Tasks tab: "Make tomorrow's lunch [not Fri]").
  // cfg.skip[routine][task index] = weekday numbers (0 = Sunday) when it isn't needed. It counts as done on those days.
  function skipped(cfg, k, i, s) { var r = cfg.skip && cfg.skip[k] && cfg.skip[k][i]; return !!(r && s && r.indexOf(dow(s)) >= 0); }
  function fillSkips(cfg, d, s) { if (!cfg.skip || !d || !d.t) return d; Object.keys(d.t).forEach(function (k) { d.t[k].forEach(function (_, i) { if (skipped(cfg, k, i, s)) d.t[k][i] = true; }); }); return d; }

  function blankDay(cfg) {
    var t = {};
    ROUTINES.forEach(function (r) { t[r.k] = (cfg.tasks[r.k] || []).map(function () { return false; }); });
    return { t: t, chk: {}, nc: false, behs: [], deds: [], warns: [], strikes: [], started: {}, mem: {}, memDone: {}, memOk: {}, peeked: {}, practiceDone: {} };
  }
  // Make a stored day match the current task lists (tasks can be edited in the Sheet).
  function normalizeDay(cfg, d) {
    var b = blankDay(cfg);
    d = d || {};
    ['chk', 'started', 'mem', 'memDone', 'memOk', 'peeked', 'practiceDone'].forEach(function (key) { b[key] = d[key] || {}; });
    b.nc = !!d.nc;
    b.behs = d.behs || [];
    b.deds = d.deds || [];
    b.warns = d.warns || [];
    b.strikes = d.strikes || [];
    ROUTINES.forEach(function (r) {
      var src = (d.t && d.t[r.k]) || [];
      b.t[r.k] = b.t[r.k].map(function (_, i) { return !!src[i]; });
    });
    return b;
  }

  /**
   * Build the calculator for one snapshot of data.
   * cfg:  { rules, tasks, shop, startDate }
   * data: { days:{ayla:{date:day}, lani:{...}}, spending:[], requests:[], notes:[], goal:{} }
   */
  function make(cfg, data, today) {
    var R = cfg.rules;
    var pts = { before: R.before, after: R.after, night: R.night, chores: R.chores,
      wkmorn: R.wkmorn == null ? 1 : R.wkmorn, monday: R.monday == null ? 2 : R.monday };
    var STRIKE_MAX = R.strikeMax || 3;
    GIRLS.forEach(function (g) { Object.keys((data.days && data.days[g]) || {}).forEach(function (s) { fillSkips(cfg, data.days[g][s], s); }); });
    function inRange(s) { return s >= cfg.startDate && s <= today; }
    function pk(g, s) { return data.days[g] && data.days[g][s]; }
    function day(g, s) {
      if (!data.days[g]) data.days[g] = {};
      if (!data.days[g][s]) data.days[g][s] = fillSkips(cfg, blankDay(cfg), s);
      return data.days[g][s];
    }
    function allDone(d, k) { return d.t[k].length > 0 && d.t[k].every(Boolean); }
    function finished(g, host, k) { var d = pk(g, host); return !!d && (!!d.chk[k] || allDone(d, k)); }
    function full(g, s) { var d = pk(g, s); return !!d && isWk(s) && !!d.chk.before && !!d.chk.after && !!d.chk.night; }
    // Every routine that belongs to the day is checked (weekdays: the same as full).
    function fullDay(g, s) { var d = pk(g, s); return !!d && ownKeys(dow(s)).every(function (k) { return !!d.chk[k]; }); }
    function strikeCount(g, s) { var d = pk(g, s); return d ? d.strikes.length : 0; }
    function bedtime(g, s) { return strikeCount(g, s) >= STRIKE_MAX; }
    // No-chasing bonus: every routine of the day checked, the switch on, and no strike that day.
    function noChase(g, s) { var d = pk(g, s); return !!d && fullDay(g, s) && !!d.nc && !d.strikes.length; }
    function streakTo(g, s) {
      var n = 0, cur = s;
      for (var i = 0; i < 800 && cur >= cfg.startDate; i++) {
        if (isWk(cur)) { if (full(g, cur)) n++; else break; }
        cur = add(cur, -1);
      }
      return n;
    }
    function streakBonus(g, s) { return full(g, s) && streakTo(g, s) % R.streakDays === 0 ? R.streakBonus : 0; }
    function memOk(g, s, k) { var d = pk(g, s); return !!d && !!d.chk[k] && !!d.memOk[k]; }
    function dailyMaster(g, s) { return isWk(s) && MEM_ROUT.every(function (k) { return memOk(g, s, k); }); }
    function weeklyMaster(g, fri) {
      for (var i = 0; i < 5; i++) { var s = add(weekStart(fri), i); if (s < cfg.startDate || !dailyMaster(g, s)) return false; }
      return true;
    }
    function dayPts(g, s) {
      var d = pk(g, s); if (!d || s < cfg.startDate) return 0;
      var p = 0;
      ownKeys(dow(s)).forEach(function (k) { if (d.chk[k]) p += pts[k]; });
      if (noChase(g, s)) p += R.bonus;
      if (isWk(s)) p += streakBonus(g, s);
      if (d.chk.chores) p += pts.chores;
      if (dow(s) === 5 && weeklyMaster(g, s)) p += R.weeklyMaster;
      return p + d.behs.length;
    }
    function daysOf(g) { return Object.keys(data.days[g] || {}).filter(inRange); }
    function earned(g) { return daysOf(g).reduce(function (a, s) { return a + dayPts(g, s); }, 0); }
    function spent(g) { return data.spending.filter(function (x) { return x.g === g && x.date >= cfg.startDate; }).reduce(function (a, x) { return a + x.cost; }, 0); }
    // Points taken away only come off the points to spend (not the team jar, week, streaks or badges).
    function lostOn(g, s) { var d = pk(g, s); if (!d || s < cfg.startDate) return 0; return d.deds.filter(function (x) { return !x.fixed; }).length + d.strikes.filter(function (x) { return x.pt; }).length; }
    function lost(g) { return daysOf(g).reduce(function (a, s) { return a + lostOn(g, s); }, 0); }
    function balance(g) { return earned(g) - spent(g) - lost(g); }
    // Warnings last until Sunday night (Monday to Sunday week). Each comes back as { date, w }.
    function weekWarns(g, s) {
      var out = [], ws = weekStart(s);
      for (var i = 0; i < 7; i++) {
        var x = add(ws, i); if (x > s) break;
        var d = pk(g, x); if (d) (d.warns || []).forEach(function (w) { out.push({ date: x, w: w }); });
      }
      return out;
    }
    function warnedFor(g, s, why) { return weekWarns(g, s).filter(function (e) { return e.w.why === why; })[0] || null; }
    // Strikes this week that came from one warning.
    function strikesFrom(g, s, wid) {
      var out = [], ws = weekStart(s);
      for (var i = 0; i < 7; i++) {
        var x = add(ws, i), d = pk(g, x);
        if (d) (d.strikes || []).forEach(function (k) { if (k.warn === wid) out.push({ date: x, k: k }); });
      }
      return out;
    }
    function weekDates(s) { var ws = weekStart(s), out = []; for (var i = 0; i < 7; i++) out.push(add(ws, i)); return out; }
    function weekPts(g) { return weekDates(today).reduce(function (a, s) { return a + (s <= today ? dayPts(g, s) : 0); }, 0); }
    function monthPts(g) { return daysOf(g).filter(function (s) { return s.slice(0, 7) === today.slice(0, 7); }).reduce(function (a, s) { return a + dayPts(g, s); }, 0); }
    function curStreak(g) {
      if (full(g, today)) return streakTo(g, today);
      var s = add(today, -1); while (!isWk(s)) s = add(s, -1);
      return s < cfg.startDate ? 0 : streakTo(g, s);
    }
    function bestStreak(g) { return daysOf(g).filter(isWk).reduce(function (m, s) { return Math.max(m, streakTo(g, s)); }, 0); }
    function noChaseCount(g) { return daysOf(g).filter(function (s) { return isWk(s) && noChase(g, s); }).length; }
    function memCount(g, k) { return daysOf(g).filter(function (s) { return memOk(g, s, k); }).length; }
    function dailyMasterCount(g) { return daysOf(g).filter(function (s) { return dailyMaster(g, s); }).length; }
    function weeklyMasterCount(g) { return daysOf(g).filter(function (s) { return dow(s) === 5 && weeklyMaster(g, s); }).length; }
    function routinesFor(s) {
      var w = dow(s), out = [];
      if (isWk(s)) ROUTINES.slice(0, 3).forEach(function (r) { out.push({ r: r, host: s }); });
      if (w === 5) out.push({ r: ROUTINES[3], host: s });
      if (w === 6) { // Saturday: weekend morning, chores (count for Friday), night
        out.push({ r: ROUTINES[4], host: s });
        out.push({ r: ROUTINES[3], host: add(s, -1) });
        out.push({ r: ROUTINES[2], host: s });
      }
      if (w === 0) [4, 5, 2].forEach(function (i) { out.push({ r: ROUTINES[i], host: s }); }); // Sunday
      return out;
    }
    function nightLocked(g, s) { var k = nightGate(dow(s)); return !!k && !finished(g, s, k); }
    function isMemRun(d, k) { return !!d.memDone[k]; }
    function waitingOn(g, s) {
      return routinesFor(s).filter(function (x) { var d = pk(g, x.host); return d && allDone(d, x.r.k) && !d.chk[x.r.k]; });
    }
    function checkAllList(g, s) {
      return routinesFor(s).filter(function (x) { var d = pk(g, x.host); return d && allDone(d, x.r.k) && !d.chk[x.r.k] && !isMemRun(d, x.r.k); });
    }
    return {
      pts: pts, R: R, today: today, pk: pk, day: day, allDone: allDone, finished: finished, full: full,
      streakTo: streakTo, streakBonus: streakBonus, memOk: memOk, dailyMaster: dailyMaster, weeklyMaster: weeklyMaster,
      dayPts: dayPts, earned: earned, spent: spent, balance: balance, lostOn: lostOn, lost: lost, weekDates: weekDates, weekPts: weekPts, monthPts: monthPts,
      curStreak: curStreak, bestStreak: bestStreak, noChaseCount: noChaseCount, memCount: memCount,
      dailyMasterCount: dailyMasterCount, weeklyMasterCount: weeklyMasterCount, routinesFor: routinesFor,
      nightLocked: nightLocked, isMemRun: isMemRun, waitingOn: waitingOn, checkAllList: checkAllList,
      fullDay: fullDay, noChase: noChase, strikeCount: strikeCount, bedtime: bedtime, strikeMax: STRIKE_MAX,
      weekWarns: weekWarns, warnedFor: warnedFor, strikesFrom: strikesFrom
    };
  }

  /**
   * Apply one action to the data. Used for the instant update on the page and,
   * with the same rules, by the script before saving to the Sheet.
   * me: { who:'ayla'|'lani'|'parent', name:'Ayla'|'Hyrum'|... }
   * Returns { ok, error, touched:[ 'g|date' ], changed:{spending,requests,notes,goal} }.
   */
  function apply(cfg, data, today, me, op) {
    var C = make(cfg, data, today);
    var res = { ok: true, error: '', touched: [], changed: {} };
    var parent = me.who === 'parent';
    function fail(msg) { res.ok = false; res.error = msg; return res; }
    function touch(g, s) { var key = g + '|' + s; if (res.touched.indexOf(key) < 0) res.touched.push(key); }
    function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && s <= today; }
    function routineSlot(g, r, host, forGirl) {
      if (!r || !cfg.tasks[r]) return null;
      if (forGirl) {
        var ok = C.routinesFor(today).some(function (x) { return x.r.k === r && x.host === host; });
        return ok ? C.day(g, host) : null;
      }
      return validDate(host) ? C.day(g, host) : null;
    }
    var g = parent ? op.g : me.who;
    if (GIRLS.indexOf(g) < 0 && ['approve', 'decline', 'load'].indexOf(op.op) < 0) return fail('Unknown person');
    var girlOps = ['tick', 'start', 'startmem', 'peek', 'hide', 'memdone', 'practicedone', 'goal', 'cashin', 'noteSeen'];
    var parentOps = ['check', 'checkmem', 'uncheck', 'checkall', 'nochase', 'give', 'unbeh', 'take', 'fixded', 'unded', 'approve', 'decline', 'note', 'warn', 'unwarn', 'strike', 'unstrike'];
    if (girlOps.indexOf(op.op) >= 0 && parent) return fail('That is for the girls’ pages');
    if (parentOps.indexOf(op.op) >= 0 && !parent) return fail('Only a parent can do that');
    var d, r = op.r, k;
    switch (op.op) {
      case 'load': return res;
      case 'tick': {
        d = routineSlot(g, r, op.host, true); if (!d) return fail('Only today can be ticked');
        if (d.chk[r]) return fail('Already checked by a parent');
        if (r === 'night' && C.nightLocked(g, op.host)) return fail('Finish ' + (dow(op.host) === 0 ? 'Ready for Monday' : 'After school') + ' first');
        if (d.mem[r] === 'on' || d.mem[r] === 'practice') return fail('The list is hidden in memory mode');
        var i = Number(op.i); if (!(i >= 0 && i < d.t[r].length)) return fail('Unknown task');
        if (skipped(cfg, r, i, op.host)) return fail('That one isn\u2019t needed today');
        d.t[r][i] = !!op.on; d.started[r] = true; touch(g, op.host); return res;
      }
      case 'start': {
        d = routineSlot(g, r, op.host, true); if (!d) return fail('Only today can be started');
        d.started[r] = true; touch(g, op.host); return res;
      }
      case 'startmem': {
        d = routineSlot(g, r, op.host, true); if (!d) return fail('Only today can be started');
        if (MEM_ROUT.indexOf(r) < 0) return fail('Memory mode is for the daily routines');
        if (r === 'night' && C.nightLocked(g, op.host)) return fail('Finish ' + (dow(op.host) === 0 ? 'Ready for Monday' : 'After school') + ' first');
        if (d.t[r].some(function (v, j) { return v && !skipped(cfg, r, j, op.host); }) || d.chk[r]) return fail('Memory mode has to be switched on before you start');
        d.mem[r] = 'on'; d.started[r] = true; touch(g, op.host); return res;
      }
      case 'peek': {
        d = routineSlot(g, r, op.host, true); if (!d) return fail('Only today');
        if (d.mem[r] !== 'on' && d.mem[r] !== 'practice') return fail('Not in memory mode');
        d.mem[r] = 'peeked'; d.peeked[r] = true; touch(g, op.host); return res;
      }
      case 'hide': {
        d = routineSlot(g, r, op.host, true); if (!d) return fail('Only today');
        if (d.mem[r] !== 'peeked') return fail('Nothing to hide');
        d.mem[r] = 'practice'; touch(g, op.host); return res;
      }
      case 'memdone':
      case 'practicedone': {
        d = routineSlot(g, r, op.host, true); if (!d) return fail('Only today');
        var want = op.op === 'memdone' ? 'on' : 'practice';
        if (d.mem[r] !== want) return fail('Not in memory mode');
        if (r === 'night' && C.nightLocked(g, op.host)) return fail('Finish ' + (dow(op.host) === 0 ? 'Ready for Monday' : 'After school') + ' first');
        d.t[r] = d.t[r].map(function () { return true; });
        if (op.op === 'memdone') d.memDone[r] = true; else d.practiceDone[r] = true;
        touch(g, op.host); return res;
      }
      case 'goal': {
        if (op.reward && !cfg.shop.some(function (x) { return x.name === op.reward; })) return fail('Unknown reward');
        data.goal[g] = data.goal[g] === op.reward ? null : (op.reward || null);
        res.changed.goal = true; return res;
      }
      case 'cashin': {
        var item = cfg.shop.filter(function (x) { return x.name === op.reward; })[0];
        if (!item) return fail('Unknown reward');
        if (data.requests.some(function (q) { return q.g === g && q.reward === item.name && q.status === 'Waiting'; })) return fail('Already asked');
        if (C.balance(g) < item.cost) return fail('Not enough points yet');
        data.requests.push({ id: op.newId, date: today, g: g, reward: item.name, cost: item.cost, status: 'Waiting' });
        res.changed.requests = true; return res;
      }
      case 'noteSeen': {
        var n = data.notes.filter(function (x) { return x.id === op.id && x.g === g; })[0];
        if (!n) return fail('Note not found');
        n.seen = true; res.changed.notes = true; return res;
      }
      case 'check':
      case 'checkmem':
      case 'uncheck': {
        d = routineSlot(g, r, op.host, false); if (!d) return fail('Unknown routine or day');
        if (op.op === 'uncheck') { d.chk[r] = false; d.memOk[r] = false; }
        else if (op.op === 'checkmem') { if (!d.memDone[r]) return fail('Not a memory run'); d.chk[r] = true; d.memOk[r] = true; }
        else { d.chk[r] = true; d.memOk[r] = false; }
        touch(g, op.host); return res;
      }
      case 'checkall': {
        if (!validDate(op.date)) return fail('Unknown day');
        C.checkAllList(g, op.date).forEach(function (x) { var dd = C.day(g, x.host); dd.chk[x.r.k] = true; dd.memOk[x.r.k] = false; touch(g, x.host); });
        return res;
      }
      case 'nochase': {
        if (!validDate(op.date)) return fail('Unknown day');
        d = C.day(g, op.date); d.nc = !!op.on; touch(g, op.date); return res;
      }
      case 'give': {
        if (!validDate(op.date)) return fail('Unknown day');
        var why = String(op.why || '').trim().slice(0, 60);
        if (!why) return fail('Add what the point is for');
        d = C.day(g, op.date);
        if (d.behs.length >= C.R.behMax) return fail('That’s the most for the day');
        d.behs.push({ id: op.newId, for: why, by: me.name }); touch(g, op.date); return res;
      }
      case 'unbeh': {
        if (!validDate(op.date)) return fail('Unknown day');
        d = C.day(g, op.date); d.behs = d.behs.filter(function (b) { return b.id !== op.id; }); touch(g, op.date); return res;
      }
      case 'take': {
        if (op.date !== today) return fail('Points can only be taken away today');
        if (DED_REASONS.indexOf(op.why) < 0) return fail('Pick a reason');
        d = C.day(g, today);
        if (d.deds.filter(function (x) { return !x.fixed; }).length >= C.R.dedMax) return fail('That’s the most for today');
        // The balance can go below 0, so a point still comes off when she has none (03/11).
        d.deds.push({ id: op.newId, why: op.why, note: String(op.note || '').trim().slice(0, 80), by: me.name, fixed: false });
        touch(g, today); return res;
      }
      case 'fixded': {
        if (op.date !== today) return fail('A point can only be given back on the same day');
        d = C.day(g, today);
        var x = d.deds.filter(function (y) { return y.id === op.id; })[0];
        if (!x) return fail('Not found');
        if (!op.on) {
          if (d.deds.filter(function (y) { return !y.fixed; }).length >= C.R.dedMax) return fail('That’s the most for today');
        }
        x.fixed = !!op.on; touch(g, today); return res;
      }
      case 'unded': {
        if (!validDate(op.date)) return fail('Unknown day');
        d = C.day(g, op.date); d.deds = d.deds.filter(function (y) { return y.id !== op.id; }); touch(g, op.date); return res;
      }
      case 'warn': {
        if (op.date !== today) return fail('Warnings are for today');
        if (WARN_REASONS.indexOf(op.why) < 0) return fail('Pick a reason');
        // One warning per reason per week: a repeat that week is a strike (03/11).
        if (C.warnedFor(g, today, op.why)) return fail('Already warned for ' + op.why.toLowerCase() + ' this week. Tap ✖ Strike on that warning instead.');
        d = C.day(g, today);
        if (d.warns.length >= 10) return fail('That’s a lot of warnings today');
        d.warns.push({ id: op.newId, why: op.why, note: String(op.note || '').trim().slice(0, 80), by: me.name, at: String(op.at || '').slice(0, 8), struck: '' });
        touch(g, today); return res;
      }
      case 'unwarn': {
        if (op.date !== today) return fail('Only today’s warnings can be removed');
        d = C.day(g, today);
        var w0 = d.warns.filter(function (y) { return y.id === op.id; })[0];
        if (!w0) return fail('Not found');
        if (C.strikesFrom(g, today, w0.id).length) return fail('Undo the strike first');
        d.warns = d.warns.filter(function (y) { return y.id !== op.id; }); touch(g, today); return res;
      }
      case 'strike': {
        // A strike goes on today, from any warning given this week (Monday to today).
        if (op.date !== today) return fail('Strikes are for today');
        // Find the warning by its id among this week's warnings (the page doesn't need to say which day).
        var we = C.weekWarns(g, today).filter(function (e) { return e.w.id === op.id; })[0];
        if (!we) return fail('A strike needs a warning this week first');
        var w1 = we.w, wd = we.date;
        d = C.day(g, today);
        if (d.strikes.length >= C.strikeMax) return fail('That’s ' + C.strikeMax + ' strikes already today');
        d.strikes.push({ id: op.newId, warn: w1.id, wdate: wd, why: w1.why, note: w1.note, by: me.name, pt: true });
        touch(g, today); return res;
      }
      case 'unstrike': {
        if (!validDate(op.date)) return fail('Unknown day');
        d = C.day(g, op.date);
        var sx = d.strikes.filter(function (y) { return y.id === op.id; })[0];
        if (!sx) return fail('Not found');
        d.strikes = d.strikes.filter(function (y) { return y.id !== op.id; });
        var wday = sx.wdate && C.pk(g, sx.wdate) ? C.pk(g, sx.wdate) : d;
        (wday.warns || []).forEach(function (y) { if (y.struck === op.id) y.struck = ''; });
        touch(g, op.date); if (sx.wdate) touch(g, sx.wdate); return res;
      }
      case 'approve':
      case 'decline': {
        var q = data.requests.filter(function (x) { return x.id === op.id && x.status === 'Waiting'; })[0];
        if (!q) return fail('Request not found');
        if (op.op === 'approve') {
          if (C.balance(q.g) < q.cost) return fail(GIRL_NAMES[q.g] + ' doesn’t have enough points yet');
          q.status = 'Approved';
          data.spending.push({ date: today, g: q.g, reward: q.reward, cost: q.cost });
          if (data.goal[q.g] === q.reward) { data.goal[q.g] = null; res.changed.goal = true; }
          res.changed.spending = true;
        } else q.status = 'Declined';
        res.changed.requests = true; return res;
      }
      case 'note': {
        var text = String(op.text || '').trim().slice(0, 140);
        if (!text) return fail('Write the note first');
        data.notes.push({ id: op.newId, date: today, g: g, text: text, from: me.name, seen: false });
        res.changed.notes = true; return res;
      }
    }
    return fail('Unknown action');
  }

  return {
    ROUTINES: ROUTINES, MEM_ROUT: MEM_ROUT, MEM_LEVELS: MEM_LEVELS, SELF_LEVELS: SELF_LEVELS, STREAK_LEVELS: STREAK_LEVELS,
    GIRLS: GIRLS, GIRL_NAMES: GIRL_NAMES, DED_REASONS: DED_REASONS, WARN_REASONS: WARN_REASONS, ownKeys: ownKeys, nightGate: nightGate,
    add: add, dow: dow, isWk: isWk, weekStart: weekStart, skipped: skipped, blankDay: blankDay, normalizeDay: normalizeDay,
    make: make, apply: apply,
    levelIn: function (n, levels) { return levels.filter(function (x) { return n >= x; }).length; }
  };
})();
