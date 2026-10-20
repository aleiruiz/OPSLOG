import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScenarioDefinition {
  readonly id: string;
  readonly label: string;
  readonly requirement: string;
  readonly budgetMs: number;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly expectStatus: number;
}

export interface ScenarioFile {
  readonly version: number;
  readonly k6Image: string;
  readonly vus: number;
  readonly thinkMs: number;
  readonly scenarios: readonly ScenarioDefinition[];
}

export const K6_DIR = import.meta.dirname;

/** The scenarios shared by the k6 script and the Node driver. */
export function loadScenarios(): ScenarioFile {
  return JSON.parse(readFileSync(join(K6_DIR, 'scenarios.json'), 'utf8')) as ScenarioFile;
}

export interface ScenarioStats {
  readonly count: number;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Share of calls whose status was not the expected one (0..1). */
  readonly failedRate: number;
  /** Statuses (or `network`) of the calls that did not return the expected one, with their counts. */
  readonly failedStatuses?: Readonly<Record<string, number>>;
}

export interface LoadSummary {
  readonly driver: 'k6' | 'node-fetch';
  readonly k6Image?: string;
  readonly vus: number;
  readonly durationSeconds: number;
  readonly scenarios: Readonly<Record<string, ScenarioStats>>;
}
