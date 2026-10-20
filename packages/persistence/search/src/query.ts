import {
  EXACT_KEY_KINDS,
  MIN_CONTAINS_LENGTH,
  type SearchStoreQuery,
} from '../../../domain/search/src/index.js';
import { SEARCH_TABLES as T } from './entities.js';

export interface BuiltSql {
  readonly sql: string;
  readonly params: unknown[];
}

const marks = (values: readonly unknown[]) => values.map(() => '?').join(',');

/**
 * Every allowed type in ONE statement: each branch (prefix, exact keys, contains) runs once for all
 * the types, so the ngram FULLTEXT search is initialised once per request instead of twice per type.
 * Each branch is scoped to the company and to the (type, permission) pairs of the reader, and is
 * index-friendly: rank 0/1 exact or prefix on the B-tree `(company_id, entity_type, normalized)`;
 * rank 0 the blind indexes of a typed identification or license (exact kinds only); rank 2
 * "contains" through the ngram FULLTEXT index, confirmed with LIKE so that the result does not
 * depend on the server's token size. Every value is a bound parameter.
 * Per type: the best rank of each entity, the first `limit` hits and the total, via window functions.
 */
export function searchSql(query: SearchStoreQuery): BuiltSql {
  const scopes = query.types.map(
    (type) => `(entity_type = ? AND required_permission IN (${marks(type.permissions)}))`,
  );
  const scope = `company_id = ? AND (${scopes.join(' OR ')})`;
  const scopeParams = [
    query.tenantId,
    ...query.types.flatMap((type) => [type.entityType, ...type.permissions]),
  ];
  const textual = `key_kind NOT IN (${marks(EXACT_KEY_KINDS)})`;
  const cols = 'entity_type, entity_id, area_id, display';
  const branches = [
    `SELECT ${cols}, IF(normalized = ?, 0, 1) AS rnk FROM \`${T.entries}\` WHERE ${scope} AND ${textual} AND normalized LIKE ?`,
  ];
  const params: unknown[] = [query.term, ...scopeParams, ...EXACT_KEY_KINDS, `${query.term}%`];
  if (query.exactKeys.length > 0) {
    branches.push(
      `SELECT ${cols}, 0 AS rnk FROM \`${T.entries}\` WHERE ${scope} AND key_kind IN (${marks(EXACT_KEY_KINDS)}) AND normalized IN (${marks(query.exactKeys)})`,
    );
    params.push(...scopeParams, ...EXACT_KEY_KINDS, ...query.exactKeys);
  }
  if (query.term.length >= MIN_CONTAINS_LENGTH) {
    branches.push(
      `SELECT ${cols}, 2 AS rnk FROM \`${T.entries}\` WHERE MATCH(normalized) AGAINST (? IN BOOLEAN MODE) AND ${scope} AND ${textual} AND normalized LIKE ?`,
    );
    params.push(`"${query.term}"`, ...scopeParams, ...EXACT_KEY_KINDS, `%${query.term}%`);
  }
  const best = `SELECT entity_type, entity_id, MIN(area_id) AS area_id, MIN(display) AS display, MIN(rnk) AS rnk FROM (${branches.join(' UNION ALL ')}) m GROUP BY entity_type, entity_id`;
  const ranked = `SELECT b.*, ROW_NUMBER() OVER (PARTITION BY entity_type ORDER BY rnk, display, entity_id) AS rn, COUNT(*) OVER (PARTITION BY entity_type) AS n FROM (${best}) b`;
  return {
    sql: `SELECT entity_type, entity_id, area_id, display, n FROM (${ranked}) r WHERE rn <= ? ORDER BY entity_type, rn`,
    params: [...params, query.limit],
  };
}
