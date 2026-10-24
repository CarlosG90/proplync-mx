/* A small in-memory stand-in for the Supabase client: just the calls Scout makes, with the same chaining and
   the same "await the builder" behaviour. It lets run loops execute without a network. Not a test file. */
export function fakeDb(seed) {
  const db = JSON.parse(JSON.stringify(seed));
  let n = 0;
  class Q {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.patch = null; this.rows = null; this.orStr = null; this.wantRows = false; }
    select() { this.wantRows = true; return this; }
    update(p) { this.op = 'update'; this.patch = p; return this; }
    insert(r) { this.op = 'insert'; this.rows = Array.isArray(r) ? r : [r]; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
    or(str) { this.orStr = str; return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { return Promise.resolve(this.exec(true)); }
    single() { return Promise.resolve(this.exec(true, true)); }
    then(res, rej) { return Promise.resolve(this.exec(false)).then(res, rej); }
    exec(one, strict) {
      const table = (db[this.table] = db[this.table] || []);
      if (this.op === 'insert') {
        const added = this.rows.map((r) => ({ id: 'row-' + (++n), ...r }));
        table.push(...added);
        return { data: one ? added[0] : added, error: null };
      }
      let rows = table.filter((r) => this.filters.every((f) => f(r)));
      // The lease clause: "lease_until.is.null,lease_until.lt.<iso>". Any other .or() (listings by area) is ignored.
      if (this.orStr && this.orStr.startsWith('lease_until.is.null')) {
        const lt = this.orStr.split('lease_until.lt.')[1];
        rows = rows.filter((r) => !r.lease_until || r.lease_until < lt);
      }
      if (this.op === 'update') {
        rows.forEach((r) => Object.assign(r, this.patch));
        if (!this.wantRows) return { data: null, error: null };
      }
      if (one) {
        if (!rows.length) return strict ? { data: null, error: new Error('no rows') } : { data: null, error: null };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    }
  }
  return { db, from: (t) => new Q(t) };
}
