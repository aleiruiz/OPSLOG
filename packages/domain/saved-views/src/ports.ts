import type { SavedViewRecord } from './types.js';

export type CreateResult = 'created' | 'duplicate' | 'limit';
export type ReplaceResult = 'replaced' | 'stale' | 'duplicate';

/** Persistence of saved views and of the columns each member keeps visible. Every call names the company. */
export interface SavedViewStore {
  /** The views of the module that the member owns or that are shared with the company, by name. */
  list(tenantId: string, module: string, memberId: string): Promise<readonly SavedViewRecord[]>;
  get(tenantId: string, id: string): Promise<SavedViewRecord | null>;
  /** Creates unless the owner already has `max` views in the module or has one with that name. */
  create(view: SavedViewRecord, max: number): Promise<CreateResult>;
  /** Replaces the row when `expectedVersion` is still the stored one. */
  replace(next: SavedViewRecord, expectedVersion: number): Promise<ReplaceResult>;
  remove(tenantId: string, id: string): Promise<boolean>;
  getColumns(tenantId: string, memberId: string, module: string): Promise<readonly string[] | null>;
  saveColumns(
    tenantId: string,
    memberId: string,
    module: string,
    columns: readonly string[] | null,
    at: string,
  ): Promise<void>;
}

/** The lists of BRD §14.2 and what each one allows; supplied by the composition from the contracts. */
export interface ViewCatalog {
  /** `null` for a module that has no list views. */
  module(name: string): ViewModuleCatalog | null;
}

export interface ViewModuleCatalog {
  /** Permission that opens the list. */
  readonly access: string;
  readonly filters: ReadonlyMap<string, ViewFilterRule>;
  readonly sorts: ReadonlySet<string>;
  readonly columns: ReadonlyMap<string, ViewColumnRule>;
}

export interface ViewFilterRule {
  readonly label: string;
  readonly permission?: string;
  readonly accepts: (value: string) => boolean;
}

export interface ViewColumnRule {
  readonly label: string;
  readonly locked: boolean;
  readonly permission?: string;
}
