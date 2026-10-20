import {
  EXACT_KEY_KINDS,
  MIN_CONTAINS_LENGTH,
  type SearchStoreQuery,
  type SearchTypeQuery,
} from '../../../domain/search/src/index.js';
import { SEARCH_TABLES as T } from './entities.js';

export interface BuiltSql {
  readonly sql: string;
  readonly params: unknown[];
}

const marks = (values: readonly unknown[]) => values.map(() => '?').join(',');

/**
 * The matches of one type as a union of three index-friendly branches, each one scoped to the
 * company, the type and the permissions of the reader:
 *  - rank 0/1: exact or prefix match on the B-tree `(company_id, entity_type, normalized)`;
 *  - rank 0: the blind indexes of a typed identification or license (exact kinds only);
 *  - rank 2: "contains" through the ngram FULLTEXT index, confirmed with LIKE so that the result
 *    does not depend on the server's token size.
 * Every value travels as a bound parameter; the term has been stripped of pattern characters.
 */
export function matchesSql(query: SearchStoreQuery, type: SearchTypeQuery): BuiltSql {
  const scope = `company_id = ? AND entity_type = ? AND required_permission IN (${marks(type.permissions)})`;
  const scopeParams = [query.tenantId, type.entityType, ...type.permissions];
  const textual = `key_kind NOT IN (${marks(EXACT_KEY_KINDS)})`;
  const branches: string[] = [
    `SELECT entity_id, area_id, display, IF(normalized = ?, 0, 1) AS rnk FROM \`${T.entries}\` WHERE ${scope} AND ${textual} AND normalized LIKE ?`,
  ];
  const params: unknown[] = [query.term, ...scopeParams, ...EXACT_KEY_KINDS, `${query.term}%`];
  if (query.exactKeys.length > 0) {
    branches.push(
      `SELECT entity_id, area_id, display, 0 AS rnk FROM \`${T.entries}\` WHERE ${scope} AND key_kind IN (${marks(EXACT_KEY_KINDS)}) AND normalized IN (${marks(query.exactKeys)})`,
    );
    params.push(...scopeParams, ...EXACT_KEY_KINDS, ...query.exactKeys);
  }
  if (query.term.length >= MIN_CONTAINS_LENGTH) {
    branches.push(
      `SELECT entity_id, area_id, display, 2 AS rnk FROM \`${T.entries}\` WHERE MATCH(normalized) AGAINST (? IN BOOLEAN MODE) AND ${scope} AND ${textual} AND normalized LIKE ?`,
    );
    params.push(`"${query.term}"`, ...scopeParams, ...EXACT_KEY_KINDS, `%${query.term}%`);
  }
  return { sql: branches.join(' UNION ALL '), params };
}

/** The best hits of the type, one row per entity, exact first, then prefix, then contains. */
export function hitsSql(query: SearchStoreQuery, type: SearchTypeQuery): BuiltSql {
  const matches = matchesSql(query, type);
  return {
    sql: `SELECT entity_id, MIN(area_id) AS area_id, MIN(display) AS display, MIN(rnk) AS rnk FROM (${matches.sql}) m GROUP BY entity_id ORDER BY rnk, display, entity_id LIMIT ?`,
    params: [...matches.params, query.limit],
  };
}

/** How many entities of the type match, whatever the limit. */
export function totalSql(query: SearchStoreQuery, type: SearchTypeQuery): BuiltSql {
  const matches = matchesSql(query, type);
  return {
    sql: `SELECT COUNT(DISTINCT entity_id) AS n FROM (${matches.sql}) m`,
    params: matches.params,
  };
}
