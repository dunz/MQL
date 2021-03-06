import {
  is_string, is_function, flatten, flatten as cat, reduce, tap, go, pipe,
  map, filter, reject, pluck, uniq, each, index_by, group_by, last, object, curry
} from 'fxjs2';
import pg from 'pg';
import mysql from 'mysql';
import load_ljoin from './ljoin.js'
import { dump } from 'dumper.js';

export const MQL_DEBUG = {
  DUMP: false,
  LOG: false
};

const SymbolColumn = Symbol('COLUMN');
const SymbolTag = Symbol('TAG');
const SymbolInjection = Symbol('INJECTION');
const SymbolDefault = Symbol('DEFAULT');

const wrap_arr = a => Array.isArray(a) ? a : [a];
const mix = (arr1, arr2) => arr1.reduce((res, item, i) => {
  res.push(item);
  i < arr2.length && res.push(arr2[i]);
  return res;
}, []);

const cmap = curry((f, arr) => Promise.all(arr.map(f)));
const first = a => a && a[0];

const is_column = f => f && f[SymbolColumn];
const is_tag = f => f && f[SymbolTag];
const is_injection = query => query == SymbolInjection;

const tag = f => typeof f == 'function' ?
  Object.assign(f, { [SymbolTag]: true }) : tag(_ => f);

function BASE({
  create_pool,
  query_fn,
  get_connection = pool => pool.connect(),
  BEGIN = client => client.query('BEGIN'),
  COMMIT = async client => {
    await client.query('COMMIT');
    return await client.release();
  },
  ROLLBACK = async client => {
    await client.query('ROLLBACK');
    return await client.release();
  },
  reg_q = /\?\?/g,
  to_q = () => '??',
  escape_dq = idtf => `"${('' + idtf).replace(/\\/g, '\\\\').replace(/"/g, '""')}"`,
  replace_q = (query) => {
    if (is_injection(query)) return SymbolInjection;
    let i = 0;
    query.text = query.text.replace(reg_q, _ => `$${++i}`);
    return query;
  },
  use_ljoin
}) {
  const add_column = me =>
    me.column == '*' ?
      COLUMN(me.as + '.*') :
      is_column(me.column) ?
        COLUMN(...go(
          me.column.originals.concat(pluck('left_key', me.rels)),
          map(c => me.as + '.' + c),
          uniq)) :
        tag(SymbolColumn);

  const columnize = v =>
    v == '*' ?
      '*' :
      v.match(/\s*\sas\s\s*/i) ?
        v.split(/\s*\sas\s\s*/i).map(dq).join(' AS ') :
        dq(v);

  const dq = str => ('' + str).split('.').map(s => s == '*' ? s : escape_dq(s)).join('.');

  function ready_sqls(strs, tails) {
    const options = strs
      .map(s => s
        .replace(/\s*\n/, '')
        .split('\n')
        .map((s) => {
          var depth = s.match(/^\s*/)[0].length,
            as = s.trim(),
            rel_type;

          var prefix = as.substr(0, 2);
          if (['- ', '< ', 'x '].includes(prefix)) {
            rel_type = prefix.trim();
            as = as.substr(1).trim();
            return { depth, as, rel_type }
          } else if (prefix == 'p ') {
            rel_type = as[2];
            as = as.substr(3).trim();
            return { depth, as, rel_type, is_poly: true }
          } else {
            return { depth, as };
          }
        })
      );

      go(
        tails,
        map(tail =>
          is_tag(tail) ?
            { query: tail } :
            Object.assign({}, tail, { query: tail.query || tag() })
        ),
        Object.entries,
        each(([i, t]) => go(
          options[i],
          last,
          _ => Object.assign(_, t)
        ))
      );

      return options;
  }

  function merge_query(queries) {
    if (queries.find(is_injection)) return SymbolInjection;

    var query = reduce((res, query) => {
      if (!query) return res;
      if (query.text) res.text += (' ' + query.text);
      if (query.values) res.values.push(...query.values);
      return res;
    }, queries, {
      text: '',
      values: []
    });
    query.text = query.text.replace(/\n/g, ' ').replace(/\s\s*/g, ' ').trim();
    return query;
  }

  function VALUES(values) {
    return tag(function () {
      values = Array.isArray(values) ? values : [values];

      const columns = go(
        values,
        map(Object.keys),
        flatten,
        uniq);

      const DEFAULTS = go(
        columns,
        map(k => [k, SymbolDefault]),
        object);

      values = values
        .map(v => Object.assign({}, DEFAULTS, v))
        .map(v => Object.values(v));

      return {
        text: `(${COLUMN(...columns)().text}) VALUES (${
          values
            .map(v => v.map(v => v == SymbolDefault ? 'DEFAULT' : to_q()).join(', '))
            .join('), (')})`,
        values: flatten(values.map(v => v.filter(v => v != SymbolDefault)))
      }
    });
  }

  function COLUMN(...originals) {
    return Object.assign(tag(function() {
      return {
        text: originals
          .map(v =>
            is_string(v) ?
              columnize(v) :
            Object
              .entries(v)
              .map(v => v.map(dq).join(' AS '))
              .join(', '))
          .join(', ')
      };
    }), { [SymbolColumn]: true, originals: originals });
  }

  const CL = COLUMN, TABLE = COLUMN, TB = TABLE;

  function PARAMS(obj, sep) {
    return tag(function() {
      let i = 0;
      const text = Object.keys(obj).map(k => `${columnize(k)} = ${to_q()}`).join(sep);
      const values = Object.values(obj);
      return {
        text: text.replace(reg_q, function() {
          const value = values[i++];
          return is_column(value) ? value().text : to_q()
        }),
        values: reject(is_column, values)
      };
    });
  }

  function EQ(obj, sep = 'AND') {
    return PARAMS(obj, ' ' + sep + ' ');
  }

  function SET(obj) {
    return tag(function() {
      const query = PARAMS(obj, ', ')();
      query.text = 'SET ' + query.text;
      return query;
    });
  }

  function BASE_IN(key, operator, values) {
    values = uniq(values);

    var keys_text = COLUMN(...wrap_arr(key))().text;
    return {
      text: `${Array.isArray(key) ? `(${keys_text})` : keys_text} ${operator} (${values.map(
        Array.isArray(key) ? v => `(${v.map(to_q).join(', ')})` : to_q
      ).join(', ')})`,
      values: cat(values)
    };
  }

  function IN(key, values) {
    return tag(function() {
      return BASE_IN(key, 'IN', values);
    });
  }

  function NOT_IN(key, values) {
    return tag(function() {
      return BASE_IN(key, 'NOT IN', values);
    });
  }

  function _SQL(texts, values) {
    return go(
      mix(
        texts.map(text => ({ text })),
        values.map(value =>
          is_tag(value) ? value() : is_function(value) ? SymbolInjection : { text: to_q(), values: [value] })
      ),
      merge_query);
  }

  function SQL(texts, ...values) {
    return tag(function() {
      return _SQL(texts, values);
    });
  }

  function SQLS(sqls) {
    return tag(function() {
      return sqls.find(sql => !is_tag(sql)) ?
        SymbolInjection : merge_query(sqls.map(sql => sql()));
    });
  }

  function baseAssociate(QUERY) {
    return async function(strs, ...tails) {
      return go(
        ready_sqls(strs, tails),
        cat,
        filter(t => t.as),
        each(option => {
          option.column = option.column || '*';
          option.query = option.query || tag();
          option.table = option.table || (option.rel_type == '-' ? option.as + 's' : option.as);
          option.rels = [];
        }),
        function setting([left, ...rest]) {
          const cur = [left];
          each(me => {
            while (!(last(cur).depth < me.depth)) cur.pop();
            const left = last(cur);
            left.rels.push(me);
            if (me.rel_type == '-') {
              me.left_key = me.left_key || (me.is_poly ? 'id' : me.table.substr(0, me.table.length-1) + '_id');
              me.where_key = me.key || (me.is_poly ? 'attached_id' : 'id');
              me.xjoin = tag();
            } else if (me.rel_type == '<') {
              me.left_key = me.left_key || 'id';
              me.where_key = me.key || (me.is_poly ? 'attached_id' : left.table.substr(0, left.table.length-1) + '_id');
              me.xjoin = tag();
            } else if (me.rel_type == 'x') {
              me.left_key = me.left_key || 'id';
              me.where_key = '_#_xtable_#_.' + (me.left_xkey || left.table.substr(0, left.table.length-1) + '_id');
              var xtable = me.xtable || (left.table + '_' + me.table);
              me.xjoin = SQL `INNER JOIN ${TB(xtable)} as ${escape_dq('_#_xtable_#_')} on ${EQ({
                ['_#_xtable_#_.' + (me.xkey || me.table.substr(0, me.table.length-1) + '_id')]: COLUMN(me.as + '.' + (me.key || 'id'))
              })}`;
            }
            me.poly_type = me.is_poly ?
              SQL `AND ${EQ(
                (me.poly_type && typeof me.poly_type == 'object') ? me.poly_type : { attached_type: me.poly_type || left.table }
              )}` : tag();
            cur.push(me);
          }, rest);
          return left;
        },
        async function(me) {
          const lefts = await QUERY `
            SELECT ${add_column(me)}
              FROM ${TB(me.table)} AS ${TB(me.as)} ${me.query}`;

          return go(
            [lefts, me],
            function recur([lefts, option]) {
              return lefts.length && option.rels.length && go(option.rels, cmap(async function(me) {
                const query = me.query();
                if (query && query.text) query.text = 'AND ' + query.text.replace(/WHERE|AND/i, '');

                var fold_key = me.rel_type == 'x' ?
                  `_#_${me.where_key.split('.')[1]}_#_` : me.where_key;

                var colums = uniq(add_column(me).originals.concat(me.where_key + (me.rel_type == 'x' ? ` AS ${fold_key}` : '')));

                var in_vals = filter(a => a != null, pluck(me.left_key, lefts));

                const rights = !in_vals.length ? [] : await QUERY `
                  SELECT ${COLUMN(...colums)}
                    FROM ${TB(me.table)} AS ${TB(me.as)} 
                    ${me.xjoin} 
                    WHERE 
                      ${IN(me.where_key, in_vals)}
                      ${me.poly_type}
                      ${tag(query)}`;

                var [folder, default_value] = me.rel_type == '-' ? [index_by, () => ({})] : [group_by, () => []];

                return go(
                  rights,
                  folder(a => a[fold_key]),
                  folded => each(function(left) {
                    left._ = left._ || {};
                    left._[me.as] = folded[left[me.left_key]] || default_value();
                  }, lefts),
                  _ => recur([rights, me]),
                  _ => me.hook && each(left => left._[me.as] = me.hook(left._[me.as]), lefts));
              }));
            },
            _ => me.hook ? me.hook(lefts) : lefts
          );
        }
      );
    }
  }

  async function CONNECT(connection_info) {
    const pool = create_pool(connection_info);
    const pool_query = query_fn(pool);

    function base_query(excute_query, texts, values) {
      return go(
        _SQL(texts, values),
        replace_q,
        query => is_injection(query) ? Promise.reject('INJECTION ERROR') : query,
        tap(function(query) {
          if (MQL_DEBUG.DUMP) dump(query);
          typeof MQL_DEBUG.LOG == 'function' ?
            MQL_DEBUG.LOG(query) : (MQL_DEBUG.LOG && console.log(query));
        }),
        excute_query);
    }

    async function QUERY(texts, ...values) {
      return base_query(pool_query, texts, values);
    }

    const QUERY1 = pipe(QUERY, first),
      ASSOCIATE = baseAssociate(QUERY),
      ASSOCIATE1 = pipe(ASSOCIATE, first);

    const ljoin = use_ljoin ? await load_ljoin({
      ready_sqls, add_column, tag, MQL_DEBUG,
      connection_info, QUERY, VALUES, IN, NOT_IN, EQ, SET, COLUMN, CL, TABLE, TB, SQL, SQLS
    }) : _ => _;

    return {
      VALUES, IN, NOT_IN, EQ, SET, COLUMN, CL, TABLE, TB, SQL, MQL_DEBUG,
      QUERY,
      QUERY1,
      ASSOCIATE,
      ASSOCIATE1,
      LJOIN: ljoin(QUERY),
      async TRANSACTION() {
        try {
          const client = await get_connection(pool);
          const client_query = query_fn(client);
          await BEGIN(client);
          function QUERY(texts, ...values) {
            return base_query(client_query, texts, values);
          }
          const QUERY1 = pipe(QUERY, first),
          ASSOCIATE = baseAssociate(QUERY),
          ASSOCIATE1 = pipe(ASSOCIATE, first);
          return {
            VALUES, IN, NOT_IN, EQ, SET, COLUMN, CL, TABLE, TB, SQL,
            QUERY,
            QUERY1,
            ASSOCIATE,
            ASSOCIATE1,
            LJOIN: ljoin(QUERY),
            COMMIT: _ => COMMIT(client),
            ROLLBACK: _ => ROLLBACK(client)
          }
        } catch (e) { throw e; }
      }
    }
  }

  return { CONNECT, VALUES, IN, NOT_IN, EQ, SET, COLUMN, CL, TABLE, TB, SQL, MQL_DEBUG }
}

const method_promise = curry((name, obj) =>
  new Promise((resolve, reject) =>
      obj[name]((err, res) => err ? reject(err) : resolve(res))));

export const
  PostgreSQL = BASE({
    create_pool: connection_info => new pg.Pool(connection_info),

    query_fn: pool => pipe(pool.query.bind(pool), res => res.rows),

    use_ljoin: true
  }),
  MySQL = BASE({
    create_pool: connection_info => mysql.createPool(connection_info),

    query_fn: pool => ({text, values}) =>
      new Promise((resolve, reject) =>
        pool.query(text, values, (err, results) =>
          err ? reject(err) : resolve(results))),

    get_connection: method_promise('getConnection'),
    BEGIN: method_promise('beginTransaction'),
    COMMIT: method_promise('commit'),
    ROLLBACK: method_promise('rollback'),

    reg_q: /\?/g,
    to_q: () => '?',
    escape_dq: mysql.escapeId,
    replace_q: _ => _
  });